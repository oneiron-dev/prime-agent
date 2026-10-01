# Rolling back (Oneiron)

Three cases: back to an earlier Rust version, back to the TS build before cutover, and back to
the TS build after cutover. Releasing is in [RELEASE.md](RELEASE.md).

A rollback changes **code only**. It moves which installed version runs. It never restores
sessions, `settings.json`, `models.json`, auth, or a kernel venv, and it never deletes an
install. Older code may not read state written by newer code. If a rolled-back version fails on
newer state, roll forward again; do not restore an old copy of `~/.prime/agent-rs` without the
owner's explicit approval.

## Never run these

- Upstream `install-rust.sh`, `prime-agent update` / `/update`, or any `curl … | sh`. They
  replace `~/.local/bin/prime-agent` and stop every TS daemon.
- `pkill` / `killall` / `kill` by process name. TS and Rust daemons share the product name.
- `prime-agent shutdown` (the TS launcher), and any daemon stop without an explicit Rust
  `--daemon-socket`.
- Edits to `~/.local/bin/prime-agent`, `~/.local/share/prime-agent-oneiron/`,
  `/tmp/prime-agent-<uid>/` or `~/.prime/agent/` as part of a Rust rollback. Hand-flipping the
  Rust `current` symlink also skips the checks and the receipt.
- Homebrew `zap` or cask uninstall (it targets `~/.prime`).

## 1. Back to an earlier Rust version

```sh
python3 scripts/oneiron/side_by_side.py status          # current, previous, installed, receipts
python3 scripts/oneiron/side_by_side.py rollback        # to <prefix>/previous
python3 scripts/oneiron/side_by_side.py rollback --to 0.9.8-oneiron.20261001.1
prime-agent-rs --version
```

`rollback`:

1. Refuses a version that is not installed (an executable `prime-agent` plus a `package.json`
   naming that version) and the version that is already current. It holds the install
   prefix's lock until its receipt is written, so a concurrent `rollout` or `rollback` is
   turned away.
2. Re-hashes the target's executable and its whole payload. Both must match a receipt that
   shows the version once ran as `current`: a rollout that ended `activated`, an install that
   activated and passed its `--version` check, or an earlier rollback that ended `rolled-back`.
   A version that was installed but never selected (for example, its probe failed) is refused;
   roll it out instead.
3. Checks the Rust supervisor, the same way `rollout` does: it connects only to the Rust socket
   and refuses while there are live sessions. `--force-idle-check-skip` overrides the refusal,
   and the override is recorded.
4. Right before the swap, re-hashes the target's payload once more (the idle check can take a
   while) and checks that `current`, `previous` and the launcher are what the run started from.
   Then it rewrites the `prime-agent-rs` launcher, points `previous` at the version it leaves
   and flips `current`.
5. Checks that `prime-agent-rs --version` prints the target and that `~/.local/bin/prime-agent`
   is unchanged.
6. Writes `receipts/<target>-<platform>/ROLLBACK-RECEIPT.json` with `fromVersion`, `toVersion`,
   status, checks, both pointer states, the observed supervisor, and timings. Like the
   activation receipt it is journaled (`running` until the outcome is known, rewritten on
   entering each phase and right before the swap). An earlier rollback receipt there is kept
   under its timestamp.

Running `rollback` again goes back to the version you left. `--retire-idle-daemon` also stops
the Rust supervisor when it runs another release (read from its executable path) and is still
the same idle supervisor that was checked before the swap, so the next `prime-agent-rs` run
starts the target. It is not an atomic fence: see "Old supervisor" in
[RELEASE.md](RELEASE.md). Without it, the receipt's `notice` names the release that supervisor
keeps running.

**If the supervisor is busy:** let its sessions finish, or end them one at a time with
`prime-agent-rs list` and `prime-agent-rs stop <session>`. Then run `rollback` again.
Sessions persist on disk and can be reattached after the swap.

**If the receipt says `failed`:** `current` is only flipped in the `select` phase. A failure
before that changed nothing. A failure at `post-check` means `current` moved, but the launcher
did not report the target. Run `status`, then `rollback --to <the version you came from>`.

**If a receipt still says `running`:** that run died (killed, power loss) in the phase it names.
Check `status`: if `current` already names the new version, rerun `rollout --version <it>` to
finish the activation, or `rollback` to leave it.

## 2. Back to the TS build before cutover

Nothing to undo. `prime-agent` (the TS launcher at `~/.local/bin/prime-agent`) was never
changed. Keep using it. The Rust trial uses its own agent dir, socket dir and kernel venv, so
TS state is untouched. To stop the Rust trial, stop using `prime-agent-rs`. Its supervisor keeps
running on the Rust socket dir until something stops it; it touches only Rust state, so leaving
it is safe (`--retire-idle-daemon` only retires a supervisor of a release other than the one
being selected). You can also remove
the launcher by hand: `rm ~/.local/bin/prime-agent-rs`. The installs and receipts stay; removing
`~/.local/share/prime-agent-oneiron-rs/` is optional and loses the receipts.

## 3. Back to the TS build after cutover

Cutover (a separate, owner-approved step, not done by these scripts) repoints
`~/.local/bin/prime-agent` at the Rust launcher. Before you flip it, record its current target
in the cutover receipt:

```sh
readlink ~/.local/bin/prime-agent        # e.g. /home/<you>/.local/share/prime-agent-oneiron/<ts-install>/bin/prime-agent
```

To go back, restore that exact target atomically. Write a temporary symlink and rename it over
the launcher; never `rm` first:

```sh
ln -s '<recorded TS target>' ~/.local/bin/.prime-agent.restore
mv -T ~/.local/bin/.prime-agent.restore ~/.local/bin/prime-agent   # GNU; on macOS: mv -f
readlink ~/.local/bin/prime-agent && prime-agent --version
```

Then:

- New TS runs start the TS daemon on its own socket dir. Rust daemons keep their own socket
  dir. Stop the Rust one only with an explicit Rust socket, never with machine-wide shutdown.
- If sessions were shared after cutover, the TS build may not read state the Rust build wrote
  (see "Never point a Rust run at TS sessions" in `RUST-BASE.md`). Keep the Rust install, so
  forward recovery stays possible.
