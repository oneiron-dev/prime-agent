//! The streaming main-screen flush (TS `exitFullscreen`'s inline
//! repaint): the exit path that renders the inline frame section by
//! section and writes the changed rows into the user's native
//! scrollback in bounded chunks.

use super::AgentView;
use crate::Line;

impl AgentView {
    /// Stream the changed rows of the inline layout to `out` as the main-screen flush: the one
    /// output path that writes into the user's native scrollback, so its byte stream is
    /// parity-frozen. `self.flushed_frame` is the diff base.
    ///
    /// - rows extending the flushed frame append into scrollback;
    /// - a change above the flushed tail repaints the last screenful
    ///   (scrollback is immutable);
    /// - an identical frame writes nothing.
    ///
    /// # Errors
    ///
    /// Propagates the write error when `out` rejects a chunk: the rows already written have
    /// scrolled, so the flush is not retried.
    pub fn stream_flush_to(
        &mut self,
        out: &mut dyn std::io::Write,
        width: usize,
        screen_height: usize,
    ) -> std::io::Result<()> {
        let layout = self.layout_pass(width);
        let mut sink = FlushSink {
            flushed: std::mem::take(&mut self.flushed_frame),
            texts: Vec::new(),
            ring: std::collections::VecDeque::new(),
            chunk: String::new(),
            screen_height,
            appending: false,
            repaint: false,
        };
        sink.feed(out, &layout.splash)?;
        let mut preceded_by_tool_activity = false;
        for (index, entry) in self.chat.iter().enumerate() {
            let rows =
                self.render_entry(index, entry, width, index == 0, preceded_by_tool_activity);
            sink.feed(out, &rows)?;
            preceded_by_tool_activity = Self::is_compact_neighbor(entry);
        }
        sink.feed(out, &layout.tail)?;
        let dock = self.render_dock(width);
        sink.feed(out, &dock)?;
        sink.finish(out)?;
        self.flushed_frame = std::mem::take(&mut sink.texts);
        Ok(())
    }
}

/// Bound each progress write, including a single oversized encoded row. Small writes keep
/// a draining terminal's proof fresh without extending the exit watchdog's grace window.
const CHUNK_BYTES: usize = 4 * 1024;

fn write_progress(out: &mut dyn std::io::Write, bytes: &[u8]) -> std::io::Result<()> {
    for chunk in bytes.chunks(CHUNK_BYTES) {
        out.write_all(chunk)?;
        crate::exit_guard::note_exit_progress();
    }
    Ok(())
}

/// The streaming main-screen flush state: feeds rows section by section, routes them between
/// the append stream and the repaint ring, writes in bounded chunks.
struct FlushSink {
    /// The last flush's row texts — the diff base.
    flushed: Vec<String>,
    /// The new frame's row texts (the NEXT flush's diff base).
    texts: Vec<String>,
    /// The most recent `screen_height` rows, for the repaint write.
    ring: std::collections::VecDeque<crate::Line>,
    /// The encoded append rows not yet handed to `out`.
    chunk: String,
    screen_height: usize,
    /// Set once a row extends the flushed frame: every later row appends.
    appending: bool,
    /// Set when a row inside the flushed frame changed: every row lands
    /// in the repaint ring instead.
    repaint: bool,
}

impl FlushSink {
    /// Feed one section of the inline frame.
    fn feed(&mut self, out: &mut dyn std::io::Write, rows: &[crate::Line]) -> std::io::Result<()> {
        for row in rows {
            let index = self.texts.len();
            let text = row_text_of(row);
            if self.appending {
                crate::interactive::write_flush_rows(&mut self.chunk, std::slice::from_ref(row));
                self.texts.push(text);
                if self.chunk.len() >= CHUNK_BYTES {
                    write_progress(out, self.chunk.as_bytes())?;
                    self.chunk.clear();
                }
            } else if self.repaint || index >= self.flushed.len() {
                // A changed row turns the write into a repaint; a row
                // past the flushed frame turns it into an append.
                if self.repaint {
                    self.ring_push(row);
                } else {
                    self.appending = true;
                    crate::interactive::write_flush_rows(
                        &mut self.chunk,
                        std::slice::from_ref(row),
                    );
                }
                self.texts.push(text);
            } else {
                if self.flushed[index].as_str() != text.as_str() {
                    self.repaint = true;
                }
                self.ring_push(row);
                self.texts.push(text);
            }
        }
        Ok(())
    }

    /// Keep the repaint ring at one screenful.
    fn ring_push(&mut self, row: &crate::Line) {
        self.ring.push_back(row.clone());
        while self.ring.len() > self.screen_height {
            self.ring.pop_front();
        }
    }

    /// Write what the decided mode owes: the append tail, the repaint
    /// erase plus the ring, or nothing for an identical frame.
    fn finish(&mut self, out: &mut dyn std::io::Write) -> std::io::Result<()> {
        if self.appending {
            if !self.chunk.is_empty() {
                write_progress(out, self.chunk.as_bytes())?;
                self.chunk.clear();
            }
        } else if self.repaint || self.texts.len() < self.flushed.len() {
            // A frame that shrank never rewinds into a rewrite of
            // scrollback: the changed region repaints the visible window.
            let mut buffer = String::from("\x1b[2J\x1b[H");
            let ring: Vec<crate::Line> = std::mem::take(&mut self.ring).into_iter().collect();
            crate::interactive::write_flush_rows(&mut buffer, &ring);
            write_progress(out, buffer.as_bytes())?;
            self.chunk.clear();
        }
        Ok(())
    }
}

/// Concatenated span contents of a row (includes zero-width OSC zone
/// markers, which must persist into scrollback).
fn row_text_of(line: &Line) -> String {
    line.iter().map(|span| span.content.as_str()).collect()
}

/// Split a string at a char boundary.
pub(super) fn split_at_chars(text: &str, at: usize) -> (&str, &str) {
    let mut end = text.len();
    let mut count = 0;
    for (index, _) in text.char_indices() {
        if count == at {
            end = index;
            break;
        }
        count += 1;
    }
    if count < at {
        return (text, "");
    }
    (&text[..end], &text[end..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Default, PartialEq, Eq)]
    struct CapturedWrites {
        bytes: Vec<u8>,
        lengths: Vec<usize>,
    }

    impl std::io::Write for CapturedWrites {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes.extend_from_slice(bytes);
            self.lengths.push(bytes.len());
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn oversized_append_and_repaint_rows_keep_progress_writes_bounded() {
        let row = vec![crate::Span::raw("界".repeat(CHUNK_BYTES))];
        for (flushed, repaint) in [(Vec::new(), false), (vec!["old".to_string()], true)] {
            let mut sink = FlushSink {
                flushed,
                texts: Vec::new(),
                ring: std::collections::VecDeque::new(),
                chunk: String::new(),
                screen_height: 40,
                appending: false,
                repaint: false,
            };
            let mut actual = CapturedWrites::default();
            sink.feed(&mut actual, std::slice::from_ref(&row))
                .expect("feed row");
            sink.finish(&mut actual).expect("finish flush");
            let mut expected = if repaint {
                String::from("\x1b[2J\x1b[H")
            } else {
                String::new()
            };
            crate::interactive::write_flush_rows(&mut expected, std::slice::from_ref(&row));
            let bytes = expected.into_bytes();
            let lengths = bytes.chunks(CHUNK_BYTES).map(<[u8]>::len).collect();
            assert_eq!(actual, CapturedWrites { bytes, lengths });
        }
    }
}
