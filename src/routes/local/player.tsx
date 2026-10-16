import { createFileRoute } from "@tanstack/react-router";
import { VideoPlayer } from "@/components/playback/videoPlayer/VideoPlayer";

/**
 * Local (downloaded) playback. Lives outside the `_api` guard so it works with no server.
 */
export const Route = createFileRoute("/local/player")({
	component: VideoPlayer,
});
