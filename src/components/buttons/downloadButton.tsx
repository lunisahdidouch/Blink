import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import { green } from "@mui/material/colors";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation } from "@tanstack/react-query";
import { useSnackbar } from "notistack";
import React, { type MouseEvent, useState } from "react";
import DownloadDialog from "@/components/downloadDialog";
import { DOWNLOAD_NOT_ALLOWED_MESSAGE } from "@/utils/constants/downloads";
import { downloadsOpenFolder } from "@/utils/downloads/commands";
import {
	describeDownloadError,
	manifestErrorText,
	percentDone,
} from "@/utils/downloads/format";
import {
	replannerFor,
	useCurrentServer,
	useDownloadSettings,
	usePlanContext,
} from "@/utils/downloads/hooks";
import { usePlayDownloaded } from "@/utils/downloads/localPlayback";
import {
	canDownload,
	isDownloadableItem,
	planDownload,
} from "@/utils/downloads/plan";
import {
	useDownload,
	useDownloadProgress,
	useDownloadsStore,
} from "@/utils/downloads/store";
import { useCentralStore } from "@/utils/store/central";

type DownloadButtonProps = {
	item: BaseItemDto;
	size?: "small" | "medium" | "large";
	variant?: "icon" | "full";
	/** Audio track selected on the page; default for the dialog. */
	defaultAudioTrack?: number | "auto";
};

const Icon = ({
	name,
	color,
	fill,
}: {
	name: string;
	color?: string;
	fill?: boolean;
}) => (
	<span
		className={
			fill ? "material-symbols-rounded fill" : "material-symbols-rounded"
		}
		style={{ color }}
	>
		{name}
	</span>
);

const ProgressRing = ({ value }: { value: number | null }) => (
	<Box sx={{ position: "relative", display: "inline-flex" }}>
		<CircularProgress
			size={24}
			thickness={4}
			variant={value === null ? "indeterminate" : "determinate"}
			value={value ?? undefined}
		/>
		{value !== null && (
			<Box
				sx={{
					inset: 0,
					position: "absolute",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				<Typography
					variant="caption"
					sx={{ fontSize: "0.5rem", fontWeight: 600 }}
				>
					{Math.round(value)}
				</Typography>
			</Box>
		)}
	</Box>
);

const DownloadButton = ({
	item,
	size = "medium",
	variant = "icon",
	defaultAudioTrack,
}: DownloadButtonProps) => {
	const user = useCentralStore((s) => s.currentUser);
	const server = useCurrentServer();
	const ctx = usePlanContext();
	const settings = useDownloadSettings();
	const manifest = useDownload(server.data?.id, item.Id);
	const live = useDownloadProgress(manifest?.id);
	const { enqueueSnackbar } = useSnackbar();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
	const store = useDownloadsStore.getState;
	const playDownloaded = usePlayDownloaded();

	const action = useMutation({
		mutationFn: async (
			kind:
				| "quick"
				| "pause"
				| "resume"
				| "cancel"
				| "delete"
				| "folder"
				| "play",
		) => {
			switch (kind) {
				case "quick": {
					if (!ctx) throw new Error("Not connected to the server");
					const planned = await planDownload(ctx, item, {
						quality: settings.data?.defaultQuality ?? "auto",
						audioStreamIndex:
							typeof defaultAudioTrack === "number"
								? defaultAudioTrack
								: undefined,
					});
					if (planned.mayNotPlay) {
						// Needs confirmation: hand over to the dialog.
						setDialogOpen(true);
						return;
					}
					await store().enqueue(planned.job);
					enqueueSnackbar(`Downloading "${item.Name}"`, { variant: "success" });
					return;
				}
				case "pause":
					return manifest && store().pause(manifest.id);
				case "resume":
					return (
						manifest &&
						store().resume(manifest.id, replannerFor(ctx, manifest.serverId))
					);
				case "cancel":
					return manifest && store().cancel(manifest.id);
				case "delete":
					return manifest && store().remove(manifest.id);
				case "folder":
					return downloadsOpenFolder(manifest?.id);
				case "play":
					return manifest && playDownloaded(manifest);
			}
		},
		onError: (e) =>
			enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
	});

	if (!isDownloadableItem(item)) return null;

	const run = (kind: Parameters<typeof action.mutate>[0]) => () => {
		setMenuAnchor(null);
		action.mutate(kind);
	};

	const openMenu = (e: MouseEvent<HTMLElement>) => {
		e.stopPropagation();
		setMenuAnchor(e.currentTarget);
	};

	const allowed = canDownload(user);
	let icon: React.ReactNode;
	let tooltip: string;
	let onClick: (e: MouseEvent<HTMLElement>) => void = openMenu;
	const status = manifest?.status;

	if (!allowed && !manifest) {
		icon = <Icon name="file_download_off" />;
		tooltip = DOWNLOAD_NOT_ALLOWED_MESSAGE;
	} else if (!manifest) {
		icon = <Icon name="download" />;
		tooltip = "Download";
		onClick = (e) => {
			e.stopPropagation();
			if (settings.data?.askEachTime === false) action.mutate("quick");
			else setDialogOpen(true);
		};
	} else if (status === "queued") {
		icon = <Icon name="schedule" />;
		tooltip = "Waiting to download";
	} else if (status === "downloading") {
		icon = <ProgressRing value={percentDone(manifest, live)} />;
		tooltip = "Downloading";
	} else if (status === "paused") {
		icon = <Icon name="pause_circle" />;
		tooltip = "Download paused";
	} else if (status === "failed") {
		icon = <Icon name="error" color="#ff6b6b" />;
		tooltip = manifestErrorText(manifest) || "Download failed";
	} else {
		icon = <Icon name="download_done" color={green.A700} />;
		tooltip = "Downloaded";
	}

	const busy = action.isPending;
	const button =
		variant === "full" ? (
			<Button
				variant="outlined"
				size={size}
				startIcon={busy ? <CircularProgress size={18} /> : icon}
				onClick={onClick}
				disabled={(!allowed && !manifest) || busy}
				//@ts-expect-error - white is a custom theme color
				color="white"
			>
				{tooltip}
			</Button>
		) : (
			<IconButton
				size={size}
				onClick={onClick}
				disabled={(!allowed && !manifest) || busy}
				aria-label={tooltip}
			>
				{busy ? <CircularProgress size={22} /> : icon}
			</IconButton>
		);

	return (
		<>
			<Tooltip title={tooltip}>
				{/* span keeps the tooltip working on a disabled button */}
				<span>{button}</span>
			</Tooltip>
			<Menu
				anchorEl={menuAnchor}
				open={!!menuAnchor}
				onClose={() => setMenuAnchor(null)}
				onClick={(e) => e.stopPropagation()}
				slotProps={{ paper: { className: "glass" } }}
			>
				{status === "completed" && (
					<MenuItem onClick={run("play")}>
						<ListItemIcon>
							<Icon name="play_arrow" />
						</ListItemIcon>
						<ListItemText>Play downloaded</ListItemText>
					</MenuItem>
				)}
				{status === "downloading" && (
					<MenuItem onClick={run("pause")}>
						<ListItemIcon>
							<Icon name="pause" />
						</ListItemIcon>
						<ListItemText>Pause</ListItemText>
					</MenuItem>
				)}
				{(status === "paused" || status === "failed") && (
					<MenuItem onClick={run("resume")}>
						<ListItemIcon>
							<Icon name="play_arrow" />
						</ListItemIcon>
						<ListItemText>
							{status === "failed" ? "Retry" : "Resume"}
						</ListItemText>
					</MenuItem>
				)}
				{status && status !== "completed" && (
					<MenuItem onClick={run("cancel")}>
						<ListItemIcon>
							<Icon name="close" />
						</ListItemIcon>
						<ListItemText>Cancel download</ListItemText>
					</MenuItem>
				)}
				{status === "completed" && (
					<MenuItem onClick={run("delete")}>
						<ListItemIcon>
							<Icon name="delete" />
						</ListItemIcon>
						<ListItemText>Delete download</ListItemText>
					</MenuItem>
				)}
				{status === "completed" && (
					<MenuItem onClick={run("folder")}>
						<ListItemIcon>
							<Icon name="folder_open" />
						</ListItemIcon>
						<ListItemText>Show in folder</ListItemText>
					</MenuItem>
				)}
			</Menu>
			{dialogOpen && (
				<DownloadDialog
					open={dialogOpen}
					onClose={() => setDialogOpen(false)}
					item={item}
					defaultAudioTrack={defaultAudioTrack}
				/>
			)}
		</>
	);
};

export default DownloadButton;
