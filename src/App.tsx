import { lazy, Suspense } from "react";

import { LoginPage, LoginPending } from "./LoginPage";
import { useSignedInUser } from "./lib/auth-client";
import { hasSessionHint } from "./lib/session-hint";

/**
 * Chat UI (markdown, panes, bookmarks) stays out of the first-visit JS.
 * Returning signed-in visitors have a session hint, so we start the chunk
 * while get-session is still in flight.
 */
const loadChatApp = () => import("./ChatApp");
const ChatApp = lazy(async () => {
	const { ChatApp: loaded } = await loadChatApp();
	return { default: loaded };
});

if (hasSessionHint()) {
	void loadChatApp();
}

function App() {
	const { user, waitForSession } = useSignedInUser();
	if (!user) {
		return waitForSession ? <LoginPending /> : <LoginPage />;
	}
	return (
		<Suspense fallback={<LoginPending />}>
			<ChatApp key={user.id} user={user} />
		</Suspense>
	);
}

export default App;
