import { strict as assert } from "assert";
import * as net from "net";
import * as vs from "vscode";
import * as ws from "ws";
import { isWin } from "../../../shared/constants";
import { LogMessage } from "../../../shared/interfaces";
import { DartToolingDaemon } from "../../../shared/services/tooling_daemon";
import { ActiveLocation, ActiveLocationChangedEvent, EventKind, ServiceMethod, Stream } from "../../../shared/services/tooling_daemon_services";
import { fsPath } from "../../../shared/utils/fs";
import { waitFor } from "../../../shared/utils/promises";
import { getActiveRealFileEditor } from "../../../shared/vscode/editors";
import { activate, closeAllOpenFiles, defer, delay, flutterHelloWorldMainFile, helloWorldMainFile, openFile, privateApi, sb, setConfigForTest, waitForResult } from "../../helpers";

// These are basic tests for DTD. There are also some tests in `../dart_debug`.
describe("dart tooling daemon", () => {
	beforeEach("activate", () => activate());

	beforeEach("skip if not supported", async function () {
		if (!privateApi.dartCapabilities.supportsToolingDaemon)
			this.skip();
	});

	it("should respond with the correct set of IDE workspace roots", async () => {
		const daemon = privateApi.toolingDaemon;
		assert.ok(daemon);

		// Wait for daemon to be up and allow time for the extension to send roots.
		await daemon.connected;
		await delay(50);

		const result = await daemon.callMethod(ServiceMethod.getIDEWorkspaceRoots);
		assert.ok(result.ideWorkspaceRoots.length);
		const roots = vs.workspace.workspaceFolders?.map((wf) => wf.uri.toString()) ?? [];
		assert.deepStrictEqual(result.ideWorkspaceRoots, roots);
	});

	it("should be able to read files inside the workspace root", async function () {
		// https://github.com/Dart-Code/Dart-Code/issues/5210
		if (privateApi.dartCapabilities.version.startsWith("3.5."))
			this.skip();

		const daemon = privateApi.toolingDaemon;
		assert.ok(daemon);

		// Wait for daemon to be up and allow time for the extension to send roots.
		await daemon.connected;
		await delay(50);

		const initialResult = await daemon.callMethod(ServiceMethod.readFileAsString, { uri: helloWorldMainFile.toString() });
		assert.ok(initialResult.content);

		// If we're on Windows, try with different casings because it's easy to have different drive
		// letter casing from different APIs and we don't know the source of all other callers of this
		// API.
		if (isWin) {
			for (const replacer of [
				// Uppercase drive letter
				(_fullMatch, prefix, driveLetter) => `${prefix}${driveLetter.toUpperCase()}:`,
				// Lowercase drive letter
				(_fullMatch, prefix, driveLetter) => `${prefix}${driveLetter.toLowerCase()}:`,
				// Encoded colon
				(_fullMatch, prefix, driveLetter) => `${prefix}${driveLetter}%3a`,
				// Not-encoded colon
				(_fullMatch, prefix, driveLetter) => `${prefix}${driveLetter}:`,
			] as Array<(_fullMatch: string, prefix: string, driveLetter: string, colon: string) => string>) {
				const uri = helloWorldMainFile.toString().replace(/(file:\/\/\/)(\w)(:|%3a|%3A)/, replacer);
				const replacedUriResult = await daemon.callMethod(ServiceMethod.readFileAsString, { uri });
				assert.ok(replacedUriResult.content);
			}
		}
	});

	it("should not be able to read files outside the workspace root", async () => {
		const daemon = privateApi.toolingDaemon;
		assert.ok(daemon);

		// Wait for daemon to be up and allow time for the extension to send roots.
		await daemon.connected;
		await delay(50);

		try {
			const result = await daemon.callMethod(ServiceMethod.readFileAsString, { uri: flutterHelloWorldMainFile.toString() });
			assert.fail(`DTD returned content outside of workspace: (${flutterHelloWorldMainFile.toString()} / ${result.content.length} bytes)`);
		} catch (e: any) {
			assert.equal(e.code, 142);
			assert.equal(e.message, "Permission denied");
		}
	});

	it("should be able to navigate to code", async () => {
		await closeAllOpenFiles(); // Ensure no false positive.
		const daemon = privateApi.toolingDaemon;
		assert.ok(daemon);
		await daemon.connected;

		const targetLine = 5;
		const targetColumn = 1;
		await daemon.callMethod(ServiceMethod.editorNavigateToCode, {
			column: targetColumn,
			line: targetLine,
			uri: helloWorldMainFile.toString(),
		});

		const editor = getActiveRealFileEditor();
		assert.ok(editor);
		assert.equal(fsPath(editor.document.uri), fsPath(helloWorldMainFile));
		assert.equal(editor.selection.active.line, targetLine - 1);
		assert.equal(editor.selection.active.character, targetColumn - 1);
	});

	it("should return an error for unsupported URI schemes", async () => {
		const daemon = privateApi.toolingDaemon;
		assert.ok(daemon);
		await daemon.connected;

		await assert.rejects(
			daemon.callMethod(ServiceMethod.editorNavigateToCode, { uri: "https://dart.dev" }),
			(error: any) => error?.code === 144,
		);
	});

	it("should expose LSP methods via the analyzer", async function () {
		if (!privateApi.dartCapabilities.supportsLspOverDtd)
			this.skip();

		const daemon = privateApi.toolingDaemon;
		assert.ok(daemon);

		// Wait for daemon to be up.
		await daemon.connected;
		await delay(50);

		// Ensure expected LSP services are registered.
		const knownServices = daemon.registeredServiceMethods;
		assert.ok(knownServices.has("Lsp.experimental/echo"), `Did not find "Lsp.experimental/echo" in ${[...knownServices].join(", ")}`);
	});

	it("should send ActiveLocationChanged events when the selection changes", async () => {
		const dtdDebounceMs = 1;
		await setConfigForTest("dart", "dtdEditorActiveLocationDelay", dtdDebounceMs); // Reduce debounce time for test.

		const daemon = privateApi.toolingDaemon;
		assert.ok(daemon);
		await daemon.connected;
		await daemon.streamListen(Stream.Editor);

		const events: ActiveLocationChangedEvent[] = [];
		const listener = daemon.onNotification(Stream.Editor, EventKind[EventKind.activeLocationChanged], (event: ActiveLocationChangedEvent) => events.push(event));
		try {
			const editor = await openFile(helloWorldMainFile);
			editor.selection = new vs.Selection(new vs.Position(0, 0), new vs.Position(0, 0));
			// Discard any first events for the above.
			await waitForResult(() => events.length >= 1);
			await delay(50); // Allow for unrelated events.
			events.length = 0;

			editor.selection = new vs.Selection(new vs.Position(1, 0), new vs.Position(2, 0));
			await delay(dtdDebounceMs + 10);
			editor.selections = [
				new vs.Selection(new vs.Position(3, 0), new vs.Position(4, 0)),
				new vs.Selection(new vs.Position(5, 0), new vs.Position(6, 0)),
			];

			// Wait for both expected events. Use waitFor and don't throw on failure because the error message
			// from the assert below will be better (we use `waitFor` just to force a delay, but continue when
			// the condition is met).
			await waitFor(() => events.length >= 2);
			assert.deepStrictEqual(
				events.map(simplify),
				[
					{
						filePath: fsPath(helloWorldMainFile),
						selections: [
							{
								active: { line: 2, character: 0 },
								anchor: { line: 1, character: 0 }
							}
						]
					},
					{
						filePath: fsPath(helloWorldMainFile),
						selections: [
							{
								active: { line: 4, character: 0 },
								anchor: { line: 3, character: 0 }
							},
							{
								active: { line: 6, character: 0 },
								anchor: { line: 5, character: 0 }
							}
						]
					},
				],
			);
		} finally {
			listener.dispose();
			await daemon.streamCancel(Stream.Editor);
		}
	});

	it("should return the current active location", async () => {
		const dtdDebounceMs = 1;
		await setConfigForTest("dart", "dtdEditorActiveLocationDelay", dtdDebounceMs); // Reduce debounce time for test.

		const daemon = privateApi.toolingDaemon;
		assert.ok(daemon);
		await daemon.connected;

		const editor = await openFile(helloWorldMainFile);
		await delay(dtdDebounceMs + 50);

		// Ensure there's an initial location for this file after opening.
		let location = await daemon.callMethod(ServiceMethod.editorGetActiveLocation);
		assert.equal(fsPath(vs.Uri.parse(location.textDocument!.uri)), fsPath(helloWorldMainFile));


		// Test a single-position update. Set twice to ensure there's always a change regardless of the
		// original position restored when the file was opened.
		editor.selection = new vs.Selection(new vs.Position(0, 0), new vs.Position(0, 0));
		editor.selection = new vs.Selection(new vs.Position(1, 0), new vs.Position(2, 0));
		await delay(dtdDebounceMs + 50);

		location = await daemon.callMethod(ServiceMethod.editorGetActiveLocation);
		assert.deepStrictEqual(
			simplify(location),
			{
				filePath: fsPath(helloWorldMainFile),
				selections: [
					{
						active: { line: 2, character: 0 },
						anchor: { line: 1, character: 0 }
					}
				]
			},
		);


		// Test a multi-selection.
		editor.selections = [
			new vs.Selection(new vs.Position(3, 0), new vs.Position(4, 0)),
			new vs.Selection(new vs.Position(5, 0), new vs.Position(6, 0)),
		];
		await delay(dtdDebounceMs + 50);
		location = await daemon.callMethod(ServiceMethod.editorGetActiveLocation);
		assert.deepStrictEqual(
			simplify(location),
			{
				filePath: fsPath(helloWorldMainFile),
				selections: [
					{
						active: { line: 4, character: 0 },
						anchor: { line: 3, character: 0 }
					},
					{
						active: { line: 6, character: 0 },
						anchor: { line: 5, character: 0 }
					}
				]
			},
		);
	});

	// Creates a locally constructed daemon connected to its own DTD process so
	// tests can exercise disconnect/dispose behaviour without affecting the
	// extension's own daemon (privateApi.toolingDaemon).
	function createDaemon<T extends typeof DartToolingDaemon>(daemonClass?: T): InstanceType<T> {
		const daemon = new (daemonClass ?? DartToolingDaemon)(
			privateApi.logger,
			privateApi.workspaceContext.sdks,
			privateApi.dartCapabilities,
			undefined,
			[],
			1000,
			() => ({}),
			async () => { },
		);
		defer("Dispose daemon", () => daemon.dispose());
		return daemon as InstanceType<T>;
	}

	it("rejects pending callMethod requests when disposed", async () => {
		const daemon = createDaemon();
		await daemon.connected;

		// The request cannot be answered once the daemon is disposed, so the
		// promise should reject rather than remain pending forever.
		const pending = daemon.callMethod(ServiceMethod.getIDEWorkspaceRoots);
		daemon.dispose();
		await assert.rejects(pending, /DTD connection is unavailable/);
	});

	it("rejects pending callMethod requests when the socket closes unexpectedly", async () => {
		const daemon = createDaemon(TestDartToolingDaemon);
		await daemon.connected;

		// Terminating the real socket in the same tick that sent the request
		// guarantees it is still pending (no response could have arrived), and
		// fires the real "close" event - the same path as an unexpected
		// network disconnect.
		const pending = daemon.callMethod(ServiceMethod.getIDEWorkspaceRoots);
		daemon.terminateSocketForTest();
		await assert.rejects(pending, /DTD connection is unavailable/);
	});

	it("reports events sent on a closed socket as a clean unavailable error", async () => {
		const daemon = createDaemon(TestDartToolingDaemon);
		await daemon.connected;

		daemon.terminateSocketForTest();
		await waitForResult(() => !daemon.hasConnection, "connection was not cleared after socket close");
		// With the connection cleared, sends should fail with the expected
		// "unavailable" error rather than a raw WebSocket "not open" error.
		assert.throws(
			() => daemon.sendEvent(Stream.Editor, { kind: EventKind.deviceRemoved, deviceId: "fake" }),
			/DTD connection is unavailable/,
		);
	});

	it("does not send on a socket that is still connecting", async () => {
		// A TCP server that accepts connections but never responds leaves the
		// client WebSocket stuck in CONNECTING state, giving a deterministic
		// window to test sends against a real non-OPEN socket.
		const serverConnections = new Set<net.Socket>();
		const server = net.createServer((conn) => {
			serverConnections.add(conn);
			conn.on("close", () => serverConnections.delete(conn));
		}).listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const socket = new ws.WebSocket(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`, { followRedirects: false });
		defer("Terminate socket and close server", () => {
			socket.terminate();
			for (const conn of serverConnections)
				conn.destroy();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		});

		const daemon = createDaemon(TestDartToolingDaemon);
		await daemon.connected;
		daemon.setConnectionForTest(socket);
		assert.equal(socket.readyState, ws.WebSocket.CONNECTING);

		const sendSpy = sb.spy(socket, "send");
		assert.throws(
			() => daemon.sendEvent(Stream.Editor, { kind: EventKind.deviceRemoved, deviceId: "fake" }),
			/DTD connection is unavailable/,
		);
		await assert.rejects(
			daemon.callMethod(ServiceMethod.getIDEWorkspaceRoots),
			/DTD connection is unavailable/,
		);
		assert.equal(sendSpy.callCount, 0, "a send reached the non-OPEN socket");
	});

	it("does not reject or log errors for fire-and-forget requests during shutdown", async () => {
		const daemon = createDaemon(TestDartToolingDaemon);
		await daemon.connected;

		const logMessages: string[] = [];
		const logListener = privateApi.logger.onLog((msg: LogMessage) => logMessages.push(msg.message));
		defer("Dispose log listener", () => { logListener.dispose(); });

		// sendWorkspaceFolders() is called fire-and-forget from real code paths,
		// so its callMethod rejection during dispose should be swallowed rather
		// than rejected or logged.
		const pending = daemon.sendWorkspaceFoldersForTest([]);
		daemon.dispose();
		await pending;

		await delay(1);
		assert.ok(
			!logMessages.some((m) => m.includes("DTD connection is unavailable")),
			`shutdown rejections produced error logging: ${logMessages.join(" | ")}`,
		);
	});

	it("logs errors for fire-and-forget requests on unexpected disconnect", async () => {
		const daemon = createDaemon(TestDartToolingDaemon);
		await daemon.connected;

		const logMessages: string[] = [];
		const logListener = privateApi.logger.onLog((msg: LogMessage) => logMessages.push(msg.message));
		defer("Dispose log listener", () => { logListener.dispose(); });

		// Unlike during shutdown, a rejection caused by an unexpected disconnect
		// should still be surfaced as an error log (but resolved rather than
		// rethrown, because fire-and-forget callers have nobody to propagate to).
		// Terminating in the same tick guarantees the request is still pending.
		const pendingFolders = daemon.sendWorkspaceFoldersForTest([]);
		daemon.terminateSocketForTest();
		await waitForResult(() => !daemon.hasConnection, "connection was not cleared after socket close");
		await pendingFolders;

		await daemon.sendActiveLocationForTest({ textDocument: undefined, selections: [] });

		assert.ok(
			logMessages.some((m) => m.includes("Failed to send workspace folders")),
			`unexpected disconnect was not logged: ${logMessages.join(" | ")}`,
		);
		assert.ok(
			logMessages.some((m) => m.includes("Failed to send active location")),
			`closed-socket send failure was not logged: ${logMessages.join(" | ")}`,
		);
	});

	it("resolves connected when disposed before connecting", async () => {
		const daemon = createDaemon();
		daemon.dispose();
		// `connected` must settle even if dispose runs before the socket opened,
		// so continuations don't wait forever.
		assert.equal(await daemon.connected, undefined);
	});
});

function simplify(e: ActiveLocation) {
	return {
		filePath: fsPath(vs.Uri.parse(e.textDocument!.uri)),
		selections: e.selections
	};
}

class TestDartToolingDaemon extends DartToolingDaemon {
	public get hasConnection(): boolean {
		return this.connection !== undefined;
	}

	public terminateSocketForTest(): void {
		this.connection?.socket.terminate();
	}

	public setConnectionForTest(socket: ws.WebSocket): void {
		// Swallow "error" events like the real error handler in connect() would,
		// otherwise closing a CONNECTING socket produces an uncaught error event.
		socket.on("error", () => { });
		this.connection = { socket, dtdUri: "ws://127.0.0.1", dtdSecret: "" };
	}

	public sendWorkspaceFoldersForTest(workspaceFolderUris: string[]): Promise<void> {
		return this.sendWorkspaceFolders(workspaceFolderUris);
	}

	public sendActiveLocationForTest(activeLocation: ActiveLocation): Promise<void> {
		return this.sendActiveLocation(activeLocation);
	}
}
