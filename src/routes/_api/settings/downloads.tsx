import {
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	FormControlLabel,
	MenuItem,
	Switch,
	TextField,
	Typography,
} from "@mui/material";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { useSnackbar } from "notistack";
// biome-ignore lint/style/useImportType: classic JSX runtime needs React in scope
import React, { useState } from "react";
import { useShallow } from "zustand/shallow";
import "../settings.scss";
import CircularPageLoadingAnimation from "@/components/circularPageLoadingAnimation";
import { DOWNLOAD_QUALITY_OPTIONS } from "@/utils/constants/downloads";
import { downloadsOpenFolder } from "@/utils/downloads/commands";
import {
	describeDownloadError,
	downloadedBytes,
	formatBytes,
} from "@/utils/downloads/format";
import {
	DOWNLOAD_SETTINGS_QUERY_KEY,
	useDownloadSettings,
} from "@/utils/downloads/hooks";
import { useDownloadsStore } from "@/utils/downloads/store";
import type { DownloadQuality } from "@/utils/downloads/types";
import {
	type DownloadSettings,
	setDownloadSetting,
} from "@/utils/storage/downloads";

type SettingChange = {
	[K in keyof DownloadSettings]: { key: K; value: DownloadSettings[K] };
}[keyof DownloadSettings];

export const Route = createFileRoute("/_api/settings/downloads")({
	component: DownloadSettingsPage,
	pendingComponent: () => <CircularPageLoadingAnimation />,
});

const Option = ({
	title,
	caption,
	control,
}: {
	title: string;
	caption: string;
	control: React.ReactElement;
}) => (
	<FormControlLabel
		control={control}
		label={
			<div className="settings-option-info">
				<Typography variant="subtitle1" fontWeight={400}>
					{title}
				</Typography>
				<Typography variant="caption" className="settings-option-info-caption">
					{caption}
				</Typography>
			</div>
		}
		labelPlacement="start"
		className="settings-option"
	/>
);

function DownloadSettingsPage() {
	const settings = useDownloadSettings();
	const queryClient = useQueryClient();
	const { enqueueSnackbar } = useSnackbar();
	const { root, items } = useDownloadsStore(
		useShallow((s) => ({ root: s.root, items: s.items })),
	);
	const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
	const all = Object.values(items);
	const used = all.reduce((n, m) => n + downloadedBytes(m), 0);

	const save = useMutation({
		mutationFn: async (args: SettingChange) =>
			setDownloadSetting(args.key, args.value),
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: DOWNLOAD_SETTINGS_QUERY_KEY }),
		onError: (e) =>
			enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
	});

	const changeFolder = useMutation({
		mutationFn: async (reset: boolean) => {
			let target: string | null = null;
			if (!reset) {
				const picked = await open({
					directory: true,
					multiple: false,
					title: "Choose a download folder",
				});
				if (!picked || Array.isArray(picked)) return null;
				target = picked;
			}
			const info = await useDownloadsStore.getState().moveRoot(target);
			await setDownloadSetting("root", reset ? null : info.root);
			return info.root;
		},
		onSuccess: (newRoot) => {
			queryClient.invalidateQueries({ queryKey: DOWNLOAD_SETTINGS_QUERY_KEY });
			if (newRoot)
				enqueueSnackbar(`Downloads now live in ${newRoot}`, {
					variant: "success",
				});
		},
		onError: (e) =>
			enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
	});

	const deleteAll = useMutation({
		mutationFn: async () => {
			const store = useDownloadsStore.getState();
			for (const id of Object.keys(store.items)) {
				await store.remove(id);
			}
		},
		onSuccess: () =>
			enqueueSnackbar("All downloads deleted", { variant: "success" }),
		onError: (e) =>
			enqueueSnackbar(describeDownloadError(e), { variant: "error" }),
	});

	if (!settings.data) return <CircularPageLoadingAnimation />;
	const s = settings.data;

	return (
		<div className="settings-page-scrollY">
			<Typography variant="h4">Downloads</Typography>
			<div className="settings-form">
				<Option
					title="Download folder"
					caption={root || "Not available"}
					control={
						<div className="flex flex-row" style={{ gap: "0.5em" }}>
							<Button
								variant="outlined"
								loading={changeFolder.isPending}
								onClick={() => changeFolder.mutate(false)}
							>
								Change folder…
							</Button>
							{s.root && (
								<Button
									onClick={() => changeFolder.mutate(true)}
									disabled={changeFolder.isPending}
								>
									Use default
								</Button>
							)}
							<Button
								onClick={() =>
									downloadsOpenFolder().catch((e) =>
										enqueueSnackbar(describeDownloadError(e), {
											variant: "error",
										}),
									)
								}
							>
								Open folder
							</Button>
						</div>
					}
				/>
				<Option
					title="Prefer downloaded copy"
					caption="Play the downloaded copy instead of streaming when an episode or movie is downloaded."
					control={
						<Switch
							checked={s.preferLocal}
							onChange={(_, v) => save.mutate({ key: "preferLocal", value: v })}
						/>
					}
				/>
				<Option
					title="Default quality"
					caption="Used for season downloads and when the download dialog is skipped."
					control={
						<TextField
							select
							hiddenLabel
							variant="filled"
							value={s.defaultQuality}
							onChange={(e) =>
								save.mutate({
									key: "defaultQuality",
									value: e.target.value as DownloadQuality,
								})
							}
							style={{ width: "14em" }}
						>
							{DOWNLOAD_QUALITY_OPTIONS.map((q) => (
								<MenuItem key={q.value} value={q.value}>
									{q.label}
								</MenuItem>
							))}
						</TextField>
					}
				/>
				<Option
					title="Ask each time"
					caption="Show the download dialog (version, audio track, quality) before every download."
					control={
						<Switch
							checked={s.askEachTime}
							onChange={(_, v) => save.mutate({ key: "askEachTime", value: v })}
						/>
					}
				/>
				<Option
					title="Delete all downloads"
					caption={`${all.length} item${all.length === 1 ? "" : "s"} · ${formatBytes(used)}`}
					control={
						<Button
							color="error"
							variant="outlined"
							disabled={all.length === 0}
							loading={deleteAll.isPending}
							onClick={() => setConfirmDeleteAll(true)}
						>
							Delete all
						</Button>
					}
				/>
			</div>
			<Dialog
				open={confirmDeleteAll}
				onClose={() => setConfirmDeleteAll(false)}
			>
				<DialogTitle>Delete all downloads?</DialogTitle>
				<DialogContent>
					<Typography>
						This removes {all.length} downloaded item
						{all.length === 1 ? "" : "s"} ({formatBytes(used)}) from this
						computer. Nothing is deleted from your server.
					</Typography>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setConfirmDeleteAll(false)}>Cancel</Button>
					<Button
						color="error"
						variant="contained"
						onClick={() => {
							setConfirmDeleteAll(false);
							deleteAll.mutate();
						}}
					>
						Delete all
					</Button>
				</DialogActions>
			</Dialog>
		</div>
	);
}
