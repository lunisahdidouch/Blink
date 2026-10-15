import type { MediaSourceInfo } from "@jellyfin/sdk/lib/generated-client";
import { describe, expect, it } from "vitest";
import { defaultAudioIndex, pickAudio, pickSubtitle } from "./trackSelection";

const source: MediaSourceInfo = {
	DefaultAudioStreamIndex: 1,
	DefaultSubtitleStreamIndex: 4,
	MediaStreams: [
		{ Type: "Video", Index: 0 },
		{ Type: "Audio", Index: 1, Language: "eng", IsDefault: true },
		{ Type: "Audio", Index: 2, Language: "jpn" },
		{ Type: "Subtitle", Index: 3, Language: "eng" },
		{ Type: "Subtitle", Index: 4, Language: "jpn" },
	],
};

describe("pickAudio", () => {
	it("prefers explicit, then language preference, then default", () => {
		expect(pickAudio(source, null, 2)).toBe(2);
		expect(pickAudio(source, { AudioLanguagePreference: "jpn" })).toBe(2);
		expect(pickAudio(source, { AudioLanguagePreference: "ger" })).toBe(1);
		expect(pickAudio(source, null)).toBe(1);
		expect(defaultAudioIndex(source)).toBe(1);
	});
});

describe("pickSubtitle", () => {
	it("prefers explicit, then language preference, then source default", () => {
		expect(pickSubtitle(source, null, -1)).toBe(-1);
		expect(pickSubtitle(source, null, 3)).toBe(3);
		expect(pickSubtitle(source, { SubtitleLanguagePreference: "eng" })).toBe(3);
		expect(pickSubtitle(source, null)).toBe(4);
	});

	it("only offers available tracks", () => {
		const onlyEng = (s: { Index?: number }) => s.Index === 3;
		expect(pickSubtitle(source, null, undefined, onlyEng)).toBe(-1);
		expect(pickSubtitle(source, null, 4, onlyEng)).toBe(-1);
		expect(
			pickSubtitle(source, { SubtitleLanguagePreference: "eng" }, undefined, onlyEng),
		).toBe(3);
	});
});
