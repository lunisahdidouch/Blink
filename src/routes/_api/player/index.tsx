import { createFileRoute } from "@tanstack/react-router";
import { VideoPlayer } from "@/components/playback/videoPlayer/VideoPlayer";

export const Route = createFileRoute("/_api/player/")({
	component: VideoPlayer,
});
