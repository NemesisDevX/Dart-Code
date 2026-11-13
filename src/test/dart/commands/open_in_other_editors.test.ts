import { strict as assert } from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vs from "vscode";
import { androidStudioPaths, isWin } from "../../../shared/constants";
import { fsPath } from "../../../shared/utils/fs";
import { activate, defer, privateApi, sb, waitForResult } from "../../helpers";
import { ChildProcessSpawnStub } from "../../mocks/child_process_spawn_stub";

// These commands spawn external editor executables (`open`, the Android
// Studio launcher) which do not exist on test machines, so all process
// spawns are faked through ChildProcessSpawnStub.
describe("OpenInOtherEditorCommands", () => {
	before("activate", () => activate());

	function makeTempDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dart-code-open-in-editor-"));
		defer("remove temp dir", () => fs.rmSync(dir, { recursive: true, force: true }));
		return dir;
	}

	const studioExecutableName = isWin ? "studio64.exe" : "studio";

	function makeAndroidStudioDir(withExecutable: boolean): string {
		const dir = makeTempDir();
		if (withExecutable) {
			fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
			fs.writeFileSync(path.join(dir, "bin", studioExecutableName), "");
		}
		return dir;
	}

	describe("flutter.openInXcode", () => {
		it("opens the .xcodeproj with Xcode", async () => {
			const folder = makeTempDir();
			const project = path.join(folder, "MyApp.xcodeproj");
			fs.mkdirSync(project);
			const spawn = ChildProcessSpawnStub.flutterConfigAndEditorSpawns();

			await vs.commands.executeCommand("flutter.openInXcode", vs.Uri.file(folder));

			assert.equal(spawn.calls.length, 1);
			assert.equal(spawn.calls[0].bin, "open");
			assert.deepEqual(spawn.calls[0].args, ["-b", "com.apple.dt.Xcode", project]);
		});

		it("prefers .xcworkspace over .xcodeproj", async () => {
			const folder = makeTempDir();
			fs.mkdirSync(path.join(folder, "MyApp.xcodeproj"));
			const workspace = path.join(folder, "MyApp.xcworkspace");
			fs.mkdirSync(workspace);
			const spawn = ChildProcessSpawnStub.flutterConfigAndEditorSpawns();

			await vs.commands.executeCommand("flutter.openInXcode", vs.Uri.file(folder));

			assert.equal(spawn.calls.length, 1);
			assert.deepEqual(spawn.calls[0].args, ["-b", "com.apple.dt.Xcode", workspace]);
		});

		it("shows an error when no Xcode project exists", async () => {
			const folder = makeTempDir();
			const showErrorMessage = sb.stub(vs.window, "showErrorMessage").resolves(undefined);
			const spawn = ChildProcessSpawnStub.flutterConfigAndEditorSpawns();

			await vs.commands.executeCommand("flutter.openInXcode", vs.Uri.file(folder));

			assert.ok(showErrorMessage.calledOnceWithExactly(`Unable to find an Xcode project in your '${path.basename(folder)}' folder`));
			assert.equal(spawn.calls.length, 0);
		});

		it("ignores non-directory entries with project extensions", async () => {
			const folder = makeTempDir();
			fs.writeFileSync(path.join(folder, "NotAProject.xcodeproj"), "");
			const showErrorMessage = sb.stub(vs.window, "showErrorMessage").resolves(undefined);
			const spawn = ChildProcessSpawnStub.flutterConfigAndEditorSpawns();

			await vs.commands.executeCommand("flutter.openInXcode", vs.Uri.file(folder));

			assert.ok(showErrorMessage.calledOnce);
			assert.equal(spawn.calls.length, 0);
		});
	});

	describe("flutter.openInAndroidStudio", () => {
		it("rejects when no Flutter SDK is available", async () => {
			sb.stub(privateApi.workspaceContext.sdks, "flutter").value(undefined);
			const folder = makeTempDir();
			ChildProcessSpawnStub.flutterConfigAndEditorSpawns();

			await assert.rejects(
				Promise.resolve(vs.commands.executeCommand("flutter.openInAndroidStudio", vs.Uri.file(folder))),
				/Cannot find Android Studio without a Flutter SDK/,
			);
		});

		it("shows an error when android-studio-dir is not configured", async () => {
			sb.stub(privateApi.workspaceContext.sdks, "flutter").value("/fake/flutter-sdk");
			const folder = makeTempDir();
			const showErrorMessage = sb.stub(vs.window, "showErrorMessage").resolves(undefined);
			ChildProcessSpawnStub.flutterConfigAndEditorSpawns({ configResult: { stdout: "{}" } });

			await vs.commands.executeCommand("flutter.openInAndroidStudio", vs.Uri.file(folder));

			assert.ok(showErrorMessage.calledOnceWithExactly("Unable to find Android Studio"));
		});

		it("launches the studio executable when configured", async () => {
			const studioDir = makeAndroidStudioDir(true);
			sb.stub(privateApi.workspaceContext.sdks, "flutter").value("/fake/flutter-sdk");
			const folder = makeTempDir();
			const folderPath = fsPath(vs.Uri.file(folder));
			const spawn = ChildProcessSpawnStub.flutterConfigAndEditorSpawns({
				configResult: { stdout: JSON.stringify({ "android-studio-dir": studioDir }) },
			});

			await vs.commands.executeCommand("flutter.openInAndroidStudio", vs.Uri.file(folder));
			await waitForResult(() => spawn.calls.length >= 2);

			const expectedBin = path.join(studioDir, androidStudioPaths[0]);
			assert.deepEqual(spawn.calls[1], { cwd: folderPath, bin: expectedBin, args: [folderPath] });
		});

		it("shows an error when the studio executable is missing", async () => {
			const studioDir = makeAndroidStudioDir(false);
			sb.stub(privateApi.workspaceContext.sdks, "flutter").value("/fake/flutter-sdk");
			const folder = makeTempDir();
			const showErrorMessage = sb.stub(vs.window, "showErrorMessage").resolves(undefined);
			ChildProcessSpawnStub.flutterConfigAndEditorSpawns({
				configResult: { stdout: JSON.stringify({ "android-studio-dir": studioDir }) },
			});

			await vs.commands.executeCommand("flutter.openInAndroidStudio", vs.Uri.file(folder));
			await waitForResult(() => showErrorMessage.called);

			assert.ok(showErrorMessage.calledOnceWithExactly("Unable to locate Android Studio executable"));
		});

		it("rejects when flutter config fails", async () => {
			sb.stub(privateApi.workspaceContext.sdks, "flutter").value("/fake/flutter-sdk");
			const folder = makeTempDir();
			ChildProcessSpawnStub.flutterConfigAndEditorSpawns({
				configResult: { exitCode: 1, stderr: "config failed" },
			});

			await assert.rejects(
				Promise.resolve(vs.commands.executeCommand("flutter.openInAndroidStudio", vs.Uri.file(folder))),
				/Failed to run "flutter config --machine"/,
			);
		});
	});
});
