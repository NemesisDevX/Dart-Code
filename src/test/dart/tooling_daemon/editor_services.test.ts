import { strict as assert } from "assert";
import { EditorServices } from "../../../extension/dart/tooling_daemon";
import { Device } from "../../../shared/flutter/daemon_interfaces";
import { IAmDisposable } from "../../../shared/interfaces";
import { DartToolingDaemon } from "../../../shared/services/tooling_daemon";
import { EventKind, Stream } from "../../../shared/services/tooling_daemon_services";
import { FlutterDeviceManager } from "../../../shared/vscode/device_manager";

describe("EditorServices lifecycle", () => {
	it("drops device events that finish after disposal, without dropping live events", async () => {
		const listeners: {
			added?: (device: Device) => Promise<void>;
			changed?: (device: Device) => Promise<void>;
			removed?: (deviceId: string) => void;
			selected?: (device: Device | undefined) => void;
		} = {};
		let disposedDeviceSubscriptions = 0;
		const subscription = (): IAmDisposable => ({
			dispose: () => disposedDeviceSubscriptions++,
		});

		let resolvePlatforms!: (platforms: never[]) => void;
		const pendingPlatforms = new Promise<never[]>((resolve) => {
			resolvePlatforms = resolve;
		});

		const deviceManager = {
			onDeviceAdded: (listener: (device: Device) => Promise<void>) => {
				listeners.added = listener;
				return subscription();
			},
			onDeviceChanged: (listener: (device: Device) => Promise<void>) => {
				listeners.changed = listener;
				return subscription();
			},
			onDeviceRemoved: (listener: (deviceId: string) => void) => {
				listeners.removed = listener;
				return subscription();
			},
			onCurrentDeviceChanged: (listener: (device: Device | undefined) => void) => {
				listeners.selected = listener;
				return subscription();
			},
			getSupportedPlatformsForWorkspace: () => pendingPlatforms,
			isSupported: () => true,
			friendlyNameForDevice: (device: Device) => device.name,
		} as unknown as FlutterDeviceManager;

		const sentEvents: EventKind[] = [];
		let daemonDisposed = false;
		const daemon = {
			registerService: async () => { },
			sendEvent: (stream: Stream, event: { kind: EventKind }) => {
				assert.equal(stream, Stream.Editor);
				if (daemonDisposed)
					throw new Error("DTD connection is unavailable");
				sentEvents.push(event.kind);
			},
		} as unknown as DartToolingDaemon;

		const services = new EditorServices(daemon, deviceManager);
		await services.register();

		assert.ok(listeners.added);
		assert.ok(listeners.changed);
		assert.ok(listeners.removed);
		assert.ok(listeners.selected);

		const device = { id: "test-device", name: "Test Device", platform: "android" } as Device;
		listeners.removed(device.id);
		assert.deepStrictEqual(sentEvents, [EventKind.deviceRemoved]);

		// These events are already in-flight and cannot be cancelled by removing
		// the event listeners. They must check disposal again after the await.
		const added = listeners.added(device);
		const changed = listeners.changed(device);
		daemonDisposed = true;
		services.dispose();
		resolvePlatforms([]);
		await Promise.all([added, changed]);

		// Captured synchronous callbacks must also be safe after disposal.
		listeners.removed(device.id);
		listeners.selected(undefined);
		assert.deepStrictEqual(sentEvents, [EventKind.deviceRemoved]);
		assert.equal(disposedDeviceSubscriptions, 4);
	});
});
