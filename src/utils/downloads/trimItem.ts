import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";

const KEEP: (keyof BaseItemDto)[] = [
	"Id",
	"Name",
	"Type",
	"SeriesId",
	"SeriesName",
	"SeasonId",
	"SeasonName",
	"ParentIndexNumber",
	"IndexNumber",
	"Overview",
	"RunTimeTicks",
	"ProductionYear",
	"PremiereDate",
	"OfficialRating",
	"CommunityRating",
	"Chapters",
	"ImageBlurHashes",
	"UserData",
];

/**
 * Trim a BaseItemDto for storage in manifest.json: only the fields the offline UI and
 * player need, and only the chosen media source. Trickplay is dropped (not available offline).
 */
export function trimItem(
	item: BaseItemDto,
	mediaSourceId?: string | null,
): BaseItemDto {
	const out: Record<string, unknown> = {};
	for (const key of KEEP) {
		if (item[key] !== undefined && item[key] !== null) out[key] = item[key];
	}
	const source =
		item.MediaSources?.find((s) => s.Id === mediaSourceId) ??
		item.MediaSources?.[0];
	if (source) {
		out.MediaSources = [source];
	}
	return out as BaseItemDto;
}
