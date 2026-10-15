import { describe, expect, it } from "vitest";
import { buildLocalQueue } from "./localPlayback";
import type { DownloadManifest } from "./types";

const m = (
	id: string,
	season: number,
	episode: number,
	extra: Partial<DownloadManifest> = {},
	seriesId: string | null = "s1",
): DownloadManifest =>
	({
		id: `srv:${id}`,
		serverId: "srv",
		itemId: id,
		status: "completed",
		item: {
			Id: id,
			Name: `E${episode}`,
			SeriesId: seriesId,
			ParentIndexNumber: season,
			IndexNumber: episode,
		},
		...extra,
	}) as DownloadManifest;

describe("buildLocalQueue", () => {
	const e = {
		s2e1: m("a", 2, 1),
		s1e2: m("b", 1, 2),
		s1e10: m("c", 1, 10),
		s1e1: m("d", 1, 1),
		otherSeries: m("e", 1, 3, {}, "s2"),
		otherServer: m("f", 1, 4, { serverId: "other", id: "other:f" }),
		notDone: m("g", 1, 5, { status: "paused" }),
	};
	const all = Object.values(e);

	it("sorts completed episodes of the same series by season, then episode", () => {
		const { queue, index } = buildLocalQueue(e.s1e2, all);
		expect(queue.map((q) => q.itemId)).toEqual(["d", "b", "c", "a"]);
		expect(index).toBe(1);
	});

	it("gives a movie a queue of one", () => {
		const movie = m("mv", 0, 0, {}, null);
		expect(buildLocalQueue(movie, [movie, ...all])).toEqual({ queue: [movie], index: 0 });
	});
});
