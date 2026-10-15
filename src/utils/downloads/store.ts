import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
	downloadsCancel,
	downloadsDelete,
	downloadsEnqueue,
	downloadsInit,
	downloadsList,
	downloadsMoveRoot,
	downloadsPause,
	downloadsResume,
	downloadsUpdateUserState,
} from "./commands";
import type {
	DownloadManifest,
	DownloadUserState,
	InitInfo,
	JobSpec,
	ProgressEvent,
} from "./types";
import { downloadId } from "./types";

export class OfflineResumeError extends Error {
	constructor(serverName: string) {
		super(`Connect to ${serverName} to resume`);
		this.name = "OfflineResumeError";
	}
}

/** Supplies a fresh JobSpec for a manifest (needs an online api for its server). */
export type Replanner = (manifest: DownloadManifest) => Promise<JobSpec>;

type DownloadsState = {
	ready: boolean;
	mediaBaseUrl: string;
	root: string;
	items: Record<string, DownloadManifest>;
	progress: Record<string, ProgressEvent>;
};

type DownloadsActions = {
	init: (root?: string | null) => Promise<void>;
	refresh: () => Promise<void>;
	enqueue: (job: JobSpec) => Promise<DownloadManifest>;
	pause: (id: string) => Promise<void>;
	/** `replan` is null when offline or connected to a different server. */
	resume: (id: string, replan: Replanner | null) => Promise<void>;
	resumeAll: (serverId: string, replan: Replanner | null) => Promise<number>;
	cancel: (id: string) => Promise<void>;
	remove: (id: string) => Promise<void>;
	updateUserState: (id: string, userState: DownloadUserState) => Promise<void>;
	moveRoot: (newRoot: string | null) => Promise<InitInfo>;
	getByItem: (
		serverId: string | null | undefined,
		itemId: string | null | undefined,
	) => DownloadManifest | undefined;
	completedForSeries: (
		serverId: string,
		seriesId: string,
	) => DownloadManifest[];
};

// Module-level so React StrictMode double effects / HMR never register twice.
let unlisteners: UnlistenFn[] | null = null;
let initPromise: Promise<void> | null = null;

const applyRoot = (info: InitInfo) =>
	useDownloadsStore.setState((s) => {
		s.root = info.root;
		s.mediaBaseUrl = info.mediaBaseUrl;
	});

export const useDownloadsStore = create<DownloadsState & DownloadsActions>()(
	immer((set, get) => ({
		ready: false,
		mediaBaseUrl: "",
		root: "",
		items: {},
		progress: {},

		init: (root) => {
			if (initPromise) return initPromise;
			initPromise = (async () => {
				const info = await downloadsInit(root ?? null);
				applyRoot(info);
				if (!unlisteners) {
					unlisteners = await Promise.all([
						listen<DownloadManifest>("downloads://status", (e) => {
							const m = e.payload;
							set((s) => {
								s.items[m.id] = m;
								if (m.status !== "downloading") delete s.progress[m.id];
							});
						}),
						listen<ProgressEvent>("downloads://progress", (e) => {
							set((s) => {
								s.progress[e.payload.id] = e.payload;
							});
						}),
						listen<{ id: string }>("downloads://removed", (e) => {
							set((s) => {
								delete s.items[e.payload.id];
								delete s.progress[e.payload.id];
							});
						}),
						listen<InitInfo>("downloads://root-changed", (e) => {
							applyRoot(e.payload);
							get().refresh();
						}),
					]);
				}
				await get().refresh();
				set((s) => {
					s.ready = true;
				});
			})().catch((e) => {
				initPromise = null;
				throw e;
			});
			return initPromise;
		},

		refresh: async () => {
			const list = await downloadsList();
			set((s) => {
				s.items = Object.fromEntries(list.map((m) => [m.id, m]));
			});
		},

		enqueue: async (job) => {
			const m = await downloadsEnqueue(job);
			set((s) => {
				s.items[m.id] = m;
			});
			return m;
		},

		pause: async (id) => {
			const m = await downloadsPause(id);
			set((s) => {
				s.items[m.id] = m;
			});
		},

		resume: async (id, replan) => {
			const m = get().items[id];
			if (!m) return;
			if (!replan) throw new OfflineResumeError(m.serverName || "the server");
			const job = await replan(m);
			const updated = await downloadsResume(job);
			set((s) => {
				s.items[updated.id] = updated;
			});
		},

		resumeAll: async (serverId, replan) => {
			const targets = Object.values(get().items).filter(
				(m) =>
					m.serverId === serverId &&
					(m.status === "paused" || m.status === "failed"),
			);
			for (const m of targets) {
				await get().resume(m.id, replan);
			}
			return targets.length;
		},

		cancel: async (id) => {
			await downloadsCancel(id);
			set((s) => {
				delete s.items[id];
				delete s.progress[id];
			});
		},

		remove: async (id) => {
			await downloadsDelete(id);
			set((s) => {
				delete s.items[id];
				delete s.progress[id];
			});
		},

		updateUserState: async (id, userState) => {
			const m = await downloadsUpdateUserState(id, userState);
			set((s) => {
				s.items[m.id] = m;
			});
		},

		moveRoot: async (newRoot) => {
			const info = await downloadsMoveRoot(newRoot);
			applyRoot(info);
			await get().refresh();
			return info;
		},

		getByItem: (serverId, itemId) =>
			serverId && itemId
				? get().items[downloadId(serverId, itemId)]
				: undefined,

		completedForSeries: (serverId, seriesId) =>
			Object.values(get().items).filter(
				(m) =>
					m.status === "completed" &&
					m.serverId === serverId &&
					m.item.SeriesId === seriesId,
			),
	})),
);

/** Subscribe to one download only (progress events don't re-render everything). */
export const useDownload = (
	serverId: string | null | undefined,
	itemId: string | null | undefined,
) =>
	useDownloadsStore((s) =>
		serverId && itemId ? s.items[downloadId(serverId, itemId)] : undefined,
	);

export const useDownloadProgress = (id: string | undefined) =>
	useDownloadsStore((s) => (id ? s.progress[id] : undefined));

export const hasCompletedDownloads = () =>
	Object.values(useDownloadsStore.getState().items).some(
		(m) => m.status === "completed",
	);
