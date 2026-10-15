/**
 * Typed wrappers around the Rust commands in `src-tauri/src/downloads/commands.rs`.
 * Rejections carry a `DownloadErrorInfo` ({ code, message }).
 */
import { invoke } from "@tauri-apps/api/core";
import type {
	DownloadErrorInfo,
	DownloadManifest,
	DownloadUserState,
	InitInfo,
	JobSpec,
} from "./types";

export class DownloadCommandError extends Error {
	code: DownloadErrorInfo["code"];
	constructor(info: DownloadErrorInfo) {
		super(info.message);
		this.name = "DownloadCommandError";
		this.code = info.code;
	}
}

const isErrorInfo = (e: unknown): e is DownloadErrorInfo =>
	typeof e === "object" &&
	e !== null &&
	"code" in e &&
	"message" in e &&
	typeof (e as DownloadErrorInfo).message === "string";

async function call<T>(cmd: string, args?: Record<string, unknown>) {
	try {
		return await invoke<T>(cmd, args);
	} catch (e) {
		if (isErrorInfo(e)) throw new DownloadCommandError(e);
		throw e;
	}
}

export const downloadsInit = (root: string | null) =>
	call<InitInfo>("downloads_init", { root });

export const downloadsList = () => call<DownloadManifest[]>("downloads_list");

export const downloadsEnqueue = (job: JobSpec) =>
	call<DownloadManifest>("downloads_enqueue", { job });

export const downloadsResume = (job: JobSpec) =>
	call<DownloadManifest>("downloads_resume", { job });

export const downloadsPause = (id: string) =>
	call<DownloadManifest>("downloads_pause", { id });

/** Cancelling discards the partial data. */
export const downloadsCancel = (id: string) =>
	call<void>("downloads_cancel", { id });

export const downloadsDelete = (id: string) =>
	call<void>("downloads_delete", { id });

export const downloadsUpdateUserState = (
	id: string,
	userState: DownloadUserState,
) => call<DownloadManifest>("downloads_update_user_state", { id, userState });

export const downloadsFreeSpace = () => call<number>("downloads_free_space");

/** `null` moves back to the default folder. */
export const downloadsMoveRoot = (newRoot: string | null) =>
	call<InitInfo>("downloads_move_root", { newRoot });

export const downloadsOpenFolder = (id?: string) =>
	call<void>("downloads_open_folder", { id: id ?? null });
