import { lazy, Suspense } from "react";

import { LoginPage, LoginPending } from "./LoginPage";
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
