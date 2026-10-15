import { getSystemApi } from "@jellyfin/sdk/lib/utils/api/system-api";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSnackbar } from "notistack";
import React, { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import {
	downloadsFreeSpace,
	downloadsOpenFolder,
} from "@/utils/downloads/commands";
import {
	describeDownloadError,
	downloadedBytes,
	formatBytes,
	formatSpeed,
	manifestErrorText,
	manifestTitle,
	percentDone,
} from "@/utils/downloads/format";
import {
	replannerFor,
	useCurrentServer,
	usePlanContext,
} from "@/utils/downloads/hooks";
import { usePlayDownloaded } from "@/utils/downloads/localPlayback";
import {
	useDownloadProgress,
	useDownloadsStore,
} from "@/utils/downloads/store";
import { flushPendingPlaystate } from "@/utils/downloads/sync";
import type { DownloadManifest } from "@/utils/downloads/types";
import { localUrl } from "@/utils/downloads/urls";
import { useApiInContext } from "@/utils/store/api";
import { useBackdropStore } from "@/utils/store/backdrop";
import { useCentralStore } from "@/utils/store/central";
import "./downloads.scss";

type DownloadsSearch = { offline?: boolean };

export const Route = createFileRoute("/downloads/")({
	component: DownloadsPage,
	validateSearch: (search: Record<string, unknown>): DownloadsSearch => ({
		offline:
			search.offline === true || search.offline === "true" ? true : undefined,
	}),
});

const Thumb = ({ m, series }: { m: DownloadManifest; series?: boolean }) => {
	const rel = series
		? (m.images.seriesPrimary ?? m.images.primary)
		: (m.images.primary ?? m.images.seriesPrimary);
	return (
		<div className={series ? "downloads-thumb poster" : "downloads-thumb"}>
			{rel ? (
				<img src={localUrl(m, rel)} alt="" loading="lazy" />
			) : (
				<span className="material-symbols-rounded">movie</span>
			)}
		</div>
	);
};

const STATUS_TEXT: Record<DownloadManifest["status"], string> = {
	queued: "Waiting",
	downloading: "Downloading",
	paused: "Paused",
	failed: "Failed",
	completed: "Downloaded",
};

function ActiveRow({
	m,
	onAction,
}: {
	m: DownloadManifest;
	onAction: (kind: "pause" | "resume" | "cancel", m: DownloadManifest) => void;
}) {
	const live = useDownloadProgress(m.id);
	const pct = percentDone(m, live);
	const done = live?.bytesDone ?? m.progress.bytesDone;
	const total = live?.bytesTotal ?? m.progress.bytesTotal;
	return (
		<div className="downloads-row">
			<Thumb m={m} />
			<div className="downloads-row-info">
				<Typography variant="subtitle1" noWrap>
					{m.item.SeriesName ? `${m.item.SeriesName} · ` : ""}
					{manifestTitle(m)}
				</Typography>
				<LinearProgress
					variant={
						pct === null && m.status === "downloading"
							? "indeterminate"
							: "determinate"
					}
					value={pct ?? 0}
					color={m.status === "failed" ? "error" : "primary"}
					className="downloads-row-progress"
				/>
				<Typography variant="caption" className="downloads-row-meta">
					{m.status === "failed" ? manifestErrorText(m) : STATUS_TEXT[m.status]}
					{" · "}
					{formatBytes(done)}
					{total ? ` of ${formatBytes(total)}` : ""}
					{m.mode === "hls" && (live?.segmentsTotal ?? m.progress.segmentsTotal)
						? ` · ${live?.segmentsDone ?? m.progress.segmentsDone ?? 0}/${live?.segmentsTotal ?? m.progress.segmentsTotal} segments`
						: ""}
					{m.status === "downloading" && live?.speedBps
						? ` · ${formatSpeed(live.speedBps)}`
						: ""}
				</Typography>
			</div>
			<div className="downloads-row-actions">
				{m.status === "downloading" && (
					<Tooltip title="Pause">
						<IconButton onClick={() => onAction("pause", m)}>
							<span className="material-symbols-rounded">pause</span>
						</IconButton>
					</Tooltip>
				)}
				{(m.status === "paused" || m.status === "failed") && (
					<Tooltip title={m.status === "failed" ? "Retry" : "Resume"}>
						<IconButton onClick={() => onAction("resume", m)}>
							<span className="material-symbols-rounded">
								{m.status === "failed" ? "refresh" : "play_arrow"}
							</span>
						</IconButton>
					</Tooltip>
				)}
				<Tooltip title="Cancel">
					<IconButton onClick={() => onAction("cancel", m)}>
						<span className="material-symbols-rounded">close</span>
					</IconButton>
				</Tooltip>
			</div>
		</div>
	);
}

function DownloadedRow({
	m,
	onPlay,
	onDelete,
}: {
	m: DownloadManifest;
	onPlay: (m: DownloadManifest) => void;
	onDelete: (m: DownloadManifest) => void;
}) {
	const runtime = m.item.RunTimeTicks ?? 0;
	const watchedPct =
		!m.userState.played && runtime > 0
			? Math.min(100, (m.userState.positionTicks / runtime) * 100)
			: 0;
	return (
		<div className="downloads-row">
			<div className="downloads-thumb-wrap">
				<Thumb m={m} />
				{watchedPct > 0 && (
					<LinearProgress
						variant="determinate"
						value={watchedPct}
						className="downloads-thumb-progress"
					/>
				)}
			</div>
			<div className="downloads-row-info">
				<Typography variant="subtitle1" noWrap>
					{manifestTitle(m)}
				</Typography>
				<Typography variant="caption" className="downloads-row-meta">
					{formatBytes(downloadedBytes(m))}
					{m.mode === "hls" ? " · compatible copy" : ""}
					{m.userState.pendingSync ? " · progress not synced yet" : ""}
				</Typography>
			</div>
			<div className="downloads-row-actions">
				{m.userState.played && (
					<Tooltip title="Watched">
						<span className="material-symbols-rounded downloads-watched">
							check_circle
						</span>
					</Tooltip>
				)}
				<Tooltip title="Play">
					<IconButton onClick={() => onPlay(m)}>
						<span className="material-symbols-rounded fill">play_arrow</span>
					</IconButton>
				</Tooltip>
				<Tooltip title="Delete download">
					<IconButton onClick={() => onDelete(m)}>
						<span className="material-symbols-rounded">delete</span>
					</IconButton>
				</Tooltip>
			</div>
		</div>
	);
}

type SeriesGroup = {
	seriesId: string;
	seriesName: string;
	poster: DownloadManifest;
	seasons: { name: string; index: number; episodes: DownloadManifest[] }[];
};

function groupDownloaded(items: DownloadManifest[]) {
	const servers = new Map<
		string,
		{
			name: string;
			series: Map<string, SeriesGroup>;
			movies: DownloadManifest[];
		}
	>();
	for (const m of items) {
		let server = servers.get(m.serverId);
		if (!server) {
			server = {
				name: m.serverName || m.serverAddress,
				series: new Map(),
				movies: [],
			};
			servers.set(m.serverId, server);
		}
		const seriesId = m.item.SeriesId;
		if (!seriesId) {
			server.movies.push(m);
			continue;
		}
		let group = server.series.get(seriesId);
		if (!group) {
			group = {
				seriesId,
				seriesName: m.item.SeriesName ?? "Series",
				poster: m,
				seasons: [],
			};
			server.series.set(seriesId, group);
		}
		if (!group.poster.images.seriesPrimary && m.images.seriesPrimary)
			group.poster = m;
		const index = m.item.ParentIndexNumber ?? 0;
		let season = group.seasons.find((s) => s.index === index);
		if (!season) {
			season = {
				index,
				name: m.item.SeasonName ?? `Season ${index}`,
				episodes: [],
			};
			group.seasons.push(season);
		}
		season.episodes.push(m);
	}
	return [...servers.entries()].map(([id, s]) => ({
		id,
		name: s.name,
		movies: s.movies.sort((a, b) =>
			(a.item.Name ?? "").localeCompare(b.item.Name ?? ""),
		),
		series: [...s.series.values()]
			.sort((a, b) => a.seriesName.localeCompare(b.seriesName))
			.map((g) => ({
				...g,
				seasons: g.seasons
					.sort((a, b) => a.index - b.index)
					.map((season) => ({
						...season,
						episodes: season.episodes.sort(
							(a, b) => (a.item.IndexNumber ?? 0) - (b.item.IndexNumber ?? 0),
						),
					})),
			})),
	}));
}

function DownloadsPage() {
	const { offline } = Route.useSearch();
	const navigate = useNavigate();
	const { enqueueSnackbar } = useSnackbar();
	const api = useApiInContext((s) => s.api);
	const user = useCentralStore((s) => s.currentUser);
	const ctx = usePlanContext();
	const server = useCurrentServer();
	const playDownloaded = usePlayDownloaded();
	const setBackdrop = useBackdropStore(useShallow((s) => s.setBackdrop));
	useEffect(() => setBackdrop(""), [setBackdrop]);

	const { ready, items } = useDownloadsStore(
		useShallow((s) => ({ ready: s.ready, items: s.items })),
	);
	const all = useMemo(() => Object.values(items), [items]);
	const active = useMemo(
		() =>
			all
				.filter((m) => m.status !== "completed")
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		[all],
	);
	const groups = useMemo(
		() => groupDownloaded(all.filter((m) => m.status === "completed")),
		[all],
	);
	const usedBytes = useMemo(
		() => all.reduce((n, m) => n + downloadedBytes(m), 0),
		[all],
	);

	const freeSpace = useQuery({
		queryKey: ["downloads", "freeSpace", all.length],
		queryFn: downloadsFreeSpace,
		enabled: ready,
		networkMode: "always",
	});

	const ping = useQuery({
		queryKey: ["downloads", "ping", api?.basePath],
		queryFn: async () => {
			if (!api) return false;
			try {
				await getSystemApi(api).getPingSystem({ timeout: 5000 });
				return true;
			} catch {
				return false;
			}
		},
		networkMode: "always",
		retry: false,
	});
	const isOffline = offline || ping.data === false;

	const [toDelete, setToDelete] = useState<DownloadManifest | null>(null);

	const action = useMutation({
		mutationFn: async ({
			kind,
			m,
		}: {
			kind: "pause" | "resume" | "cancel" | "delete" | "resumeAll";
			m?: DownloadManifest;
		}) => {
			const store = useDownloadsStore.getState();
			switch (kind) {
				case "pause":
					return m && store.pause(m.id);
				case "resume":
					return m && store.resume(m.id, replannerFor(ctx, m.serverId));
				case "cancel":
					return m && store.cancel(m.id);
				case "delete":
					return m && store.remove(m.id);
				case "resumeAll": {
					if (!server.data) return;
					const n = await store.resumeAll(
						server.data.id,
						replannerFor(ctx, server.data.id),
					);
					enqueueSnackbar(
						n
							? `Resumed ${n} download${n === 1 ? "" : "s"}`
							: "Nothing to resume",
						{
							variant: "info",
						},
					);
					return;
				}
			}
		},
		onError: (e) =>
			enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
	});

	const retryConnection = useMutation({
		mutationFn: async () => {
			const ok = await ping.refetch();
			if (!ok.data) throw new Error("The server is still unreachable");
			if (api && user?.Id && server.data) {
				await flushPendingPlaystate(api, server.data.id, user.Id);
			}
		},
		onSuccess: () => navigate({ to: "/home" }),
		onError: (e) =>
			enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
	});

	const play = (m: DownloadManifest) =>
		playDownloaded(m).catch((e) =>
			enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
		);

	return (
		<div className="downloads-page scrollY">
			<div className="downloads-header">
				<Typography variant="h3" fontWeight={600}>
					Downloads
				</Typography>
				<div className="flex flex-row" style={{ gap: "0.5em" }}>
					{active.some(
						(m) => m.status === "paused" || m.status === "failed",
					) && (
						<Button
							variant="outlined"
							onClick={() => action.mutate({ kind: "resumeAll" })}
							disabled={isOffline}
							startIcon={
								<span className="material-symbols-rounded">play_arrow</span>
							}
						>
							Resume all
						</Button>
					)}
				</div>
			</div>

			{isOffline && (
				<Alert
					severity="info"
					className="downloads-offline"
					action={
						<Button
							color="inherit"
							size="small"
							loading={retryConnection.isPending}
							onClick={() => retryConnection.mutate()}
						>
							Retry connection
						</Button>
					}
				>
					You're offline. Downloads still play; watch progress will sync later.
				</Alert>
			)}

			{!ready && (
				<Alert severity="warning">
					Downloads are unavailable. Restart Blink and try again.
				</Alert>
			)}

			{active.length > 0 && (
				<section className="downloads-section">
					<Typography variant="h5" className="downloads-section-title">
						Active
					</Typography>
					{active.map((m) => (
						<ActiveRow
							key={m.id}
							m={m}
							onAction={(kind, mm) => action.mutate({ kind, m: mm })}
						/>
					))}
				</section>
			)}

			{ready && all.length === 0 && (
				<div className="downloads-empty">
					<span className="material-symbols-rounded">download</span>
					<Typography variant="h6">No downloads yet</Typography>
					<Typography variant="body2" style={{ opacity: 0.7 }}>
						Use the download button on an episode or movie to watch it offline.
					</Typography>
				</div>
			)}

			{groups.map((g) => (
				<section key={g.id} className="downloads-section">
					{groups.length > 1 && (
						<Typography variant="overline" className="downloads-server">
							{g.name}
						</Typography>
					)}
					{g.series.map((s) => (
						<div key={s.seriesId} className="downloads-series">
							<div className="downloads-series-header">
								<Thumb m={s.poster} series />
								<Typography variant="h5">{s.seriesName}</Typography>
							</div>
							{s.seasons.map((season) => (
								<div key={season.index} className="downloads-season">
									<Typography
										variant="subtitle2"
										className="downloads-season-title"
									>
										{season.name}
									</Typography>
									{season.episodes.map((m) => (
										<DownloadedRow
											key={m.id}
											m={m}
											onPlay={play}
											onDelete={setToDelete}
										/>
									))}
								</div>
							))}
						</div>
					))}
					{g.movies.length > 0 && (
						<div className="downloads-series">
							<Typography variant="h5" className="downloads-section-title">
								Movies
							</Typography>
							{g.movies.map((m) => (
								<DownloadedRow
									key={m.id}
									m={m}
									onPlay={play}
									onDelete={setToDelete}
								/>
							))}
						</div>
					)}
				</section>
			))}

			<div className="downloads-footer">
				<Typography variant="body2" style={{ opacity: 0.7 }}>
					Using {formatBytes(usedBytes)}
					{freeSpace.isSuccess ? ` · ${formatBytes(freeSpace.data)} free` : ""}
				</Typography>
				<Button
					size="small"
					onClick={() =>
						downloadsOpenFolder().catch((e) =>
							enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
						)
					}
					startIcon={
						<span className="material-symbols-rounded">folder_open</span>
					}
				>
					Open folder
				</Button>
			</div>

			<Dialog open={!!toDelete} onClose={() => setToDelete(null)}>
				<DialogTitle>Delete download?</DialogTitle>
				<DialogContent>
					<Typography>
						"{toDelete ? manifestTitle(toDelete) : ""}" will be removed from
						this computer. It stays on your server.
					</Typography>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setToDelete(null)}>Cancel</Button>
					<Button
						color="error"
						variant="contained"
						onClick={() => {
							if (toDelete) action.mutate({ kind: "delete", m: toDelete });
							setToDelete(null);
						}}
					>
						Delete
					</Button>
				</DialogActions>
			</Dialog>
		</div>
	);
}
