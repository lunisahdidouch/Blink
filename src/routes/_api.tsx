import { getDefaultServer, getServer } from "@/utils/storage/servers";
import { getUser } from "@/utils/storage/user";
import { hasCompletedDownloads } from "@/utils/downloads/store";
import type { Api } from "@jellyfin/sdk";
import { getSystemApi } from "@jellyfin/sdk/lib/utils/api/system-api";
import { getUserApi } from "@jellyfin/sdk/lib/utils/api/user-api";
import { createFileRoute, redirect } from "@tanstack/react-router";

/** Set once the server answered a ping in this app session. */
let serverReachable = false;

/** Server unreachable: go to Downloads when there is something to play, else the error page. */
const offlineRedirect = () => {
	if (hasCompletedDownloads()) {
		return redirect({ to: "/downloads", search: { offline: true } });
	}
	return redirect({
		to: "/error/$code",
		params: {
			code: "101",
		},
	});
};

const ping = async (api: Api) => {
	await getSystemApi(api).getPingSystem({ timeout: 10_000 });
	serverReachable = true;
};

export const Route = createFileRoute("/_api")({
	beforeLoad: async ({ context, location }) => {
		console.log("RUNNING API CHECK");
		if (!context.api) {
			const currentServerId = await getDefaultServer();
			if (currentServerId) {
				const currentServer = await getServer(currentServerId);
				if (currentServer?.address) {
					const apiTemp = context.jellyfinSDK.createApi(
						currentServer?.address,
						undefined,
					);
					try {
						await ping(apiTemp);
					} catch (error) {
						console.error(error);
						throw offlineRedirect();
					}
					const userOnDisk = await getUser();
					if (userOnDisk) {
						if (location.pathname !== "/login/manual") {
							const apiTemp = context.jellyfinSDK.createApi(
								currentServer?.address,
								userOnDisk.AccessToken,
							);
							try {
								await getUserApi(apiTemp).getCurrentUser();
								// return { user: user.data };
							} catch (error) {
								console.error(error);
								throw redirect({
									to: "/login/manual",
									search: {
										redirect: location.href,
									},
								});
							}
						}
						context.createApi(currentServer?.address, userOnDisk.AccessToken);
					} else {
						context.createApi(currentServer?.address, undefined); // Creates Api

						// return { api: apiTemp };
					}
				}
			}
		} else if (context.api) {
			// The api restored from storage at startup was never checked: ping once so an
			// offline launch lands on Downloads (or the error page) instead of failing pages.
			if (!serverReachable) {
				try {
					await ping(context.api);
				} catch (error) {
					console.error(error);
					throw offlineRedirect();
				}
			}
			// if (context.api.accessToken && location.pathname !== "/login/manual") {
			// 	try {
			// 		console.info("AccessToken", context.api.accessToken);
			// 		await getUserApi(context.api).getCurrentUser(); // Verify user is able to authenticate
			// 	} catch (error) {
			// 		console.error(error);
			// 		throw redirect({
			// 			to: "/login/manual",
			// 			search: {
			// 				redirect: location.href,
			// 			},
			// 		});
			// 	}
			// }
		}
	},
});
