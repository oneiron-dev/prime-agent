export function watchFactoryParent(): () => void {
	const expected = process.env.PRIME_FACTORY_PARENT === "1";
	delete process.env.PRIME_FACTORY_PARENT;
	if (expected && !process.connected) throw new Error("Factory launcher disconnected before startup");
	const disconnected = () => process.kill(process.pid, "SIGTERM");
	if (process.connected) process.once("disconnect", disconnected);
	return () => {
		process.off("disconnect", disconnected);
		if (process.connected) process.disconnect?.();
	};
}
