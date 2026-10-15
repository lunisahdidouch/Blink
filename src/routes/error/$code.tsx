import { Button, Typography } from "@mui/material";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { relaunch } from "@tauri-apps/plugin-process";
import React from "react";
import { hasCompletedDownloads } from "@/utils/downloads/store";

export const Route = createFileRoute("/error/$code")({
	component: ErrorRoute,
});

function ErrorRoute() {
	const errorCode = Route.useParams({ select: (s) => s.code });
	const navigate = useNavigate();
	switch (errorCode) {
		case "101":
			return (
				<div
					className="flex flex-column flex-center"
					style={{ height: "100vh", gap: "0.25em" }}
				>
					<span
						className="material-symbols-rounded fill gradient-text"
						style={{ fontSize: "8em", marginBottom: "0.0em" }}
					>
						report
					</span>
					<Typography variant="h5" fontWeight={500}>
						Error connecting server.
					</Typography>
					<Typography variant="subtitle2" style={{ opacity: 0.6 }}>
						Check your internet connection or contact your server administrator
					</Typography>
					<div
						className="flex flex-center"
						style={{ gap: "1em", marginTop: "0.5em" }}
					>
						<Button
							component={Link}
							to="/setup/server/list"
							variant="contained"
						>
							Change Server
						</Button>
						<Button variant="contained" onClick={async () => await relaunch()}>
							Restart Blink
						</Button>
						{hasCompletedDownloads() && (
							<Button
								variant="contained"
								onClick={() =>
									navigate({ to: "/downloads", search: { offline: true } })
								}
							>
								Open Downloads
							</Button>
						)}
					</div>
				</div>
			);

		default:
			return <div>Error</div>;
	}
} 