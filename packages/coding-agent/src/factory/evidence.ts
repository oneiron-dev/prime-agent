import { isAbsolute } from "node:path";

/** Citation counts are not model-input budgets. All sizes below are UTF-8 bytes. */
export const FACTORY_EVIDENCE_LIMITS = {
	citations: 32,
	refBytes: 4000,
	contentBytes: 64 * 1024,
	packetBytes: 96 * 1024,
	bindingBytes: 256 * 1024,
	responseBytes: 256 * 1024,
} as const;

export function assertByteLimit(field: string, actual: number, limit: number): void {
	if (actual > limit) throw new Error(`${field}: actual ${actual} UTF-8 bytes exceeds limit ${limit}`);
}

export function boundedEvidenceString(value: unknown, field: string, limit: number): asserts value is string {
	if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value))
		throw new Error(`${field}: expected a nonempty string without control characters`);
	assertByteLimit(field, Buffer.byteLength(value, "utf8"), limit);
}

export function validateEvidenceRefs(value: unknown, field = "evidenceRefs", minimum = 0): asserts value is string[] {
	if (!Array.isArray(value)) throw new Error(`${field}: expected an array`);
	if (value.length < minimum || value.length > FACTORY_EVIDENCE_LIMITS.citations)
		throw new Error(
			`${field}.length: actual ${value.length}; limit ${minimum}..${FACTORY_EVIDENCE_LIMITS.citations}`,
		);
	for (const [index, ref] of value.entries())
		boundedEvidenceString(ref, `${field}[${index}]`, FACTORY_EVIDENCE_LIMITS.refBytes);
	if (new Set(value).size !== value.length) throw new Error(`${field}: duplicate references`);
}

export function validateManagementEvidence(
	value: unknown,
	field = "evidence",
	minimum = 0,
): asserts value is Array<{ ref: string; content: string }> {
	if (!Array.isArray(value)) throw new Error(`${field}: expected an array`);
	if (value.length < minimum || value.length > FACTORY_EVIDENCE_LIMITS.citations)
		throw new Error(
			`${field}.length: actual ${value.length}; limit ${minimum}..${FACTORY_EVIDENCE_LIMITS.citations}`,
		);
	const refs = new Set<string>();
	let bytes = 0;
	for (const [index, item] of value.entries()) {
		if (typeof item !== "object" || item === null || Array.isArray(item))
			throw new Error(`${field}[${index}]: expected {ref,content}`);
		boundedEvidenceString(item.ref, `${field}[${index}].ref`, FACTORY_EVIDENCE_LIMITS.refBytes);
		if (refs.has(item.ref)) throw new Error(`${field}[${index}].ref: duplicate reference`);
		refs.add(item.ref);
		if (item.ref.startsWith("factory:attempt:"))
			throw new Error(`${field}[${index}].ref: reserved factory receipt reference`);
		if (typeof item.content !== "string" || !item.content.trim())
			throw new Error(`${field}[${index}].content: expected nonempty substantive text`);
		bytes += Buffer.byteLength(item.content, "utf8");
	}
	assertByteLimit(`${field}.content aggregate`, bytes, FACTORY_EVIDENCE_LIMITS.contentBytes);
}

export function validateArtifactPin(value: unknown, field = "pin"): asserts value is { path: string; sha256: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${field}: expected {path,sha256}`);
	const pin = value as Record<string, unknown>;
	boundedEvidenceString(pin.path, `${field}.path`, FACTORY_EVIDENCE_LIMITS.refBytes);
	if (!isAbsolute(pin.path)) throw new Error(`${field}.path: expected an absolute path`);
	if (typeof pin.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.sha256))
		throw new Error(`${field}.sha256: expected 64 lowercase hexadecimal characters`);
}
