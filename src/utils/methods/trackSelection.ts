import type {
	MediaSourceInfo,
	MediaStream,
	UserConfiguration,
} from "@jellyfin/sdk/lib/generated-client";

/**
 * Default audio track, same rules as streaming playback:
 * explicit choice → user's preferred language → stream marked default → first audio track.
 */
export function pickAudio(
	source: Pick<MediaSourceInfo, "MediaStreams" | "DefaultAudioStreamIndex">,
	userConfig?: UserConfiguration | null,
	requested?: number | null,
): number {
	const all = source.MediaStreams?.filter((s) => s.Type === "Audio") ?? [];
	if (requested !== undefined && requested !== null) return requested;
	// Same comparison streaming has always used (an unset preference matches an unset language).
	const preferred =
		all.find((t) => t.Language === userConfig?.AudioLanguagePreference) ||
		all.find((t) => t.IsDefault) ||
		all[0];
	return preferred?.Index ?? source.DefaultAudioStreamIndex ?? 0;
}

/**
 * Default subtitle track (-1 = none), same rules as streaming playback:
 * explicit choice → user's preferred language → source default → none.
 * `available` limits the choice (e.g. to downloaded tracks).
 */
export function pickSubtitle(
	source: Pick<MediaSourceInfo, "MediaStreams" | "DefaultSubtitleStreamIndex">,
	userConfig?: UserConfiguration | null,
	requested?: number | null,
	available?: (s: MediaStream) => boolean,
): number {
	const all = (
		source.MediaStreams?.filter((s) => s.Type === "Subtitle") ?? []
	).filter((s) => (available ? available(s) : true));
	const exists = (i: number | null | undefined) =>
		i !== undefined && i !== null && all.some((s) => s.Index === i);
	if (requested !== undefined && requested !== null) {
		if (!available) return requested;
		return requested === -1 || exists(requested) ? requested : -1;
	}
	const preferred = all.find(
		(s) => s.Language === userConfig?.SubtitleLanguagePreference,
	);
	if (preferred?.Index !== undefined) return preferred.Index;
	if (!available) return source.DefaultSubtitleStreamIndex ?? -1;
	if (exists(source.DefaultSubtitleStreamIndex))
		return source.DefaultSubtitleStreamIndex as number;
	return -1;
}

/** The track the server/WebView treats as default when nothing is chosen. */
export function defaultAudioIndex(
	source: Pick<MediaSourceInfo, "MediaStreams" | "DefaultAudioStreamIndex">,
): number | undefined {
	const all = source.MediaStreams?.filter((s) => s.Type === "Audio") ?? [];
	return (
		source.DefaultAudioStreamIndex ??
		all.find((t) => t.IsDefault)?.Index ??
		all[0]?.Index ??
		undefined
	);
}
