import { lazy, Suspense } from "react";

import { LoginPage } from "./LoginPage";
import { useSignedInUser } from "./lib/auth-client";
import { hasSessionHint } from "./lib/session-hint";

/**
 * Chat UI stays out of the first-visit JS. Returning visitors have a session
 * hint, so the same dynamic import starts the chunk during get-session.
 */
const loadChatApp = () => import("./ChatApp");
const ChatApp = lazy(loadChatApp);
if (hasSessionHint()) {
	void loadChatApp();
}

/** Neutral shell — do not mount the login art while a session is expected. */
function SessionPending() {
	return <div className="app" aria-busy="true" />;
}

function App() {
	const { user, waitForSession } = useSignedInUser();
	if (!user) {
		return waitForSession ? <SessionPending /> : <LoginPage />;
	}
	return (
		<Suspense fallback={<SessionPending />}>
			<ChatApp key={user.id} user={user} />
		</Suspense>
	);
}

export default App;
