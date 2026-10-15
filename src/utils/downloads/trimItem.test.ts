import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import { describe, expect, it } from "vitest";
import { trimItem } from "./trimItem";

describe("trimItem", () => {
	const item = {
		Id: "e1",
		Name: "Pilot",
		Type: "Episode",
		SeriesId: "s1",
		SeriesName: "Show",
		ParentIndexNumber: 1,
		IndexNumber: 1,
		RunTimeTicks: 1_200_000_000,
		Chapters: [{ StartPositionTicks: 0, Name: "Intro" }],
		UserData: { PlaybackPositionTicks: 5, Played: false },
		Trickplay: { ms1: { 320: { Width: 320 } } },
		People: [{ Name: "Someone" }],
		MediaSources: [
			{ Id: "ms1", Container: "mkv", MediaStreams: [{ Type: "Video", Index: 0 }] },
			{ Id: "ms2", Container: "mp4", MediaStreams: [] },
		],
	} as unknown as BaseItemDto;

	it("keeps the listed fields and drops the rest", () => {
		const t = trimItem(item, "ms1");
		expect(t.Id).toBe("e1");
		expect(t.Chapters).toHaveLength(1);
		expect(t.UserData?.PlaybackPositionTicks).toBe(5);
		expect(t).not.toHaveProperty("Trickplay");
		expect(t).not.toHaveProperty("People");
	});

	it("keeps only the chosen media source with its streams", () => {
		expect(trimItem(item, "ms2").MediaSources?.map((s) => s.Id)).toEqual(["ms2"]);
		const t = trimItem(item, "unknown");
		expect(t.MediaSources?.map((s) => s.Id)).toEqual(["ms1"]);
		expect(t.MediaSources?.[0].MediaStreams).toHaveLength(1);
	});

	it("stays small", () => {
		expect(JSON.stringify(trimItem(item, "ms1")).length).toBeLessThan(200_000);
	});
});
