import type { MediaSourceInfo } from "@jellyfin/sdk/lib/generated-client";
import { describe, expect, it } from "vitest";
import {
	buildSubtitles,
	canDownload,
	chooseMode,
	containerExt,
	estimateBytes,
	hlsOnlyProfile,
	isHlsUrl,
	stripApiKey,
	subtitleExt,
} from "./plan";

type ModeCase = [
	Parameters<typeof chooseMode>[0],
	ReturnType<typeof chooseMode>,
];

describe("chooseMode", () => {
	const file = { mode: "file", mayNotPlay: false } as const;
	const hls = { mode: "hls", mayNotPlay: false } as const;
	const fileWarn = { mode: "file", mayNotPlay: true } as const;
	const cases: ModeCase[] = [
		// auto / original + direct play + default audio → file
		[
			{ quality: "auto", supportsDirectPlay: true, nonDefaultAudio: false },
			file,
		],
		[
			{ quality: "original", supportsDirectPlay: true, nonDefaultAudio: false },
			file,
		],
		// auto without direct play → hls
		[
			{ quality: "auto", supportsDirectPlay: false, nonDefaultAudio: false },
			hls,
		],
		[
			{ quality: "auto", supportsDirectPlay: false, nonDefaultAudio: true },
			hls,
		],
		// non-default audio on a multi-audio file → hls
		[{ quality: "auto", supportsDirectPlay: true, nonDefaultAudio: true }, hls],
		[
			{ quality: "original", supportsDirectPlay: true, nonDefaultAudio: true },
			hls,
		],
		// original without direct play → file, with a warning
		[
			{
				quality: "original",
				supportsDirectPlay: false,
				nonDefaultAudio: false,
			},
			fileWarn,
		],
		[
			{ quality: "original", supportsDirectPlay: false, nonDefaultAudio: true },
			fileWarn,
		],
		// fixed qualities → hls
		[
			{ quality: "high", supportsDirectPlay: true, nonDefaultAudio: false },
			hls,
		],
		[
			{ quality: "medium", supportsDirectPlay: false, nonDefaultAudio: true },
			hls,
		],
		[{ quality: "low", supportsDirectPlay: true, nonDefaultAudio: true }, hls],
	];
	it.each(cases)("%o", (input, expected) => {
		expect(chooseMode(input)).toEqual(expected);
	});
});

describe("subtitleExt", () => {
	it.each([
		["subrip", "vtt"],
		["srt", "vtt"],
		["SubRip", "vtt"],
		["vtt", "vtt"],
		["webvtt", "vtt"],
		["mov_text", "vtt"],
		["ass", "ass"],
		["ssa", "ssa"],
		["PGSSUB", "sup"],
		["pgssub", "sup"],
		["dvd_subtitle", null],
		["dvbsub", null],
		[undefined, null],
	])("%s", (codec, ext) => {
		expect(subtitleExt(codec)).toBe(ext);
	});
});

describe("buildSubtitles", () => {
	it("downloads text/PGS tracks and marks others unavailable", () => {
		const source: MediaSourceInfo = {
			Id: "ms1",
			MediaStreams: [
				{ Type: "Video", Index: 0, Codec: "h264" },
				{
					Type: "Subtitle",
					Index: 2,
					Codec: "ass",
					Language: "eng",
					IsDefault: true,
				},
				{
					Type: "Subtitle",
					Index: 3,
					Codec: "subrip",
					Language: "fre",
					DisplayTitle: "French",
				},
				{ Type: "Subtitle", Index: 4, Codec: "dvd_subtitle" },
				{ Type: "Subtitle", Index: 5, Codec: "PGSSUB" },
			],
		};
		const { subtitles, assets } = buildSubtitles(
			{ basePath: "http://s" },
			"item1",
			source,
		);
		expect(
			subtitles.map((s) => [s.streamIndex, s.path, s.unavailable]),
		).toEqual([
			[2, "subs/2.ass", false],
			[3, "subs/3.vtt", false],
			[4, null, true],
			[5, "subs/5.sup", false],
		]);
		expect(subtitles[0].isDefault).toBe(true);
		expect(assets).toEqual([
			{
				url: "http://s/Videos/item1/ms1/Subtitles/2/0/Stream.ass",
				relPath: "subs/2.ass",
			},
			{
				url: "http://s/Videos/item1/ms1/Subtitles/3/0/Stream.vtt",
				relPath: "subs/3.vtt",
			},
			{
				// Jellyfin serves PGS as .pgssub only; saved as .sup
				url: "http://s/Videos/item1/ms1/Subtitles/5/0/Stream.pgssub",
				relPath: "subs/5.sup",
			},
		]);
	});
});

describe("helpers", () => {
	it("picks a container extension", () => {
		expect(containerExt("mkv")).toBe("mkv");
		expect(containerExt("mov,mp4,m4a,3gp,3g2,mj2")).toBe("mp4");
		expect(containerExt("../evil")).toBe("bin");
		expect(containerExt(undefined)).toBe("bin");
	});

	it("strips api_key from transcoding URLs", () => {
		expect(
			stripApiKey(
				"http://s/videos/1/master.m3u8?DeviceId=d&api_key=secret&PlaySessionId=p",
			),
		).toBe("http://s/videos/1/master.m3u8?DeviceId=d&PlaySessionId=p");
		expect(stripApiKey("http://s/a?api_key=x")).toBe("http://s/a");
		expect(stripApiKey("http://s/a")).toBe("http://s/a");
	});

	it("estimates sizes", () => {
		const source = { Size: 1234, Bitrate: 4_000_000 };
		expect(estimateBytes("file", source, 600_000_000, null)).toBe(1234);
		// 60 s at min(3 Mbps cap, 4 Mbps source) × 1.1
		expect(estimateBytes("hls", source, 600_000_000, 3_000_000)).toBe(
			24_750_000,
		);
		expect(estimateBytes("hls", source, null, 3_000_000)).toBeNull();
	});

	it("respects the download policy", () => {
		expect(
			canDownload({ Policy: { EnableContentDownloading: true } } as never),
		).toBe(true);
		expect(
			canDownload({ Policy: { EnableContentDownloading: false } } as never),
		).toBe(false);
		expect(canDownload(null)).toBe(false);
	});
});

describe("HLS-only profile", () => {
	it("drops progressive video transcoding profiles but keeps audio ones", () => {
		const profile = hlsOnlyProfile({
			TranscodingProfiles: [
				{ Type: "Audio", Container: "aac", Protocol: "http" },
				{ Type: "Video", Container: "ts", Protocol: "hls" },
				{ Type: "Video", Container: "mkv" },
				{ Type: "Video", Container: "webm", Protocol: "http" },
			],
		} as never);
		expect(profile.TranscodingProfiles?.map((t) => t.Container)).toEqual(["aac", "ts"]);
	});

	it("recognises HLS transcoding URLs", () => {
		expect(isHlsUrl("/videos/1/master.m3u8?PlaySessionId=p")).toBe(true);
		expect(isHlsUrl("/videos/1/stream.mkv?x=1")).toBe(false);
		expect(isHlsUrl(undefined)).toBe(false);
	});
});
