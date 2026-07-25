import path from 'node:path';

import { jest } from '@jest/globals';
import { MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

// ── Mock ecovacs-deebot (must be done BEFORE dynamic import of module under test) ──

// Store all event callbacks for direct invocation in tests
const eventHandlers: Record<string, (...args: unknown[]) => void> = {};

// Handlers registered on the mock MQTT client (vacbot.ecovacs.client)
const mqttClientHandlers: Record<string, (...args: unknown[]) => void> = {};

const mockMqttClient = {
  on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    mqttClientHandlers[event] = cb;
  }),
};

const mockVacbot = {
  connect: jest.fn(),
  ecovacs: { client: mockMqttClient },
  on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    eventHandlers[event] = cb;
  }),
  once: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    // Treat once the same as on for test purposes (guard logic inside handlers)
    eventHandlers[event] = cb;
  }),
  off: jest.fn(),
  // Simulates ecovacs API responses synchronously for fetchSpotAreas
  run: jest.fn((command: string, ...args: unknown[]) => {
    if (command === 'GetMaps') {
      eventHandlers['CurrentMapMID']?.('test-map-mid');
    } else if (command === 'GetSpotAreas') {
      eventHandlers['MapSpotAreas']?.({ mapSpotAreas: [{ mapSpotAreaID: '0' }, { mapSpotAreaID: '1' }] });
    } else if (command === 'GetSpotAreaInfo') {
      const areaID = String(args[1]);
      eventHandlers['MapSpotAreaInfo']?.({ mapSpotAreaID: areaID, mapSpotAreaName: `Room ${areaID}` });
    }
  }),
  clean: jest.fn(),
  stop: jest.fn(),
  pause: jest.fn(),
  resume: jest.fn(),
  charge: jest.fn(),
  disconnect: jest.fn(),
  disconnectAsync: jest.fn().mockResolvedValue(undefined),
};

// The X2 family canonical device class — matches the e6ofmn registry entry
const mockVacuumRecord = { did: 'test-did', name: 'Deebot X2', class: 'e6ofmn' };

const mockApi = {
  connect: jest.fn().mockResolvedValue(undefined),
  devices: jest.fn().mockResolvedValue([mockVacuumRecord]),
  getVacBot: jest.fn().mockReturnValue(mockVacbot),
  uid: 'test-uid',
  resource: 'test-resource',
  user_access_token: 'test-token',
};

// Build the mock EcoVacsAPI constructor with static methods attached
const MockEcoVacsAPI = Object.assign(
  jest.fn().mockImplementation(() => mockApi),
  {
    getDeviceId: jest.fn().mockReturnValue('device-id'),
    md5: jest.fn().mockImplementation((s: string) => `md5(${s})`),
    REALM: 'ecouser.net',
  },
);

// Use unstable_mockModule so Jest's ESM VM intercepts the import in platform.ts
jest.unstable_mockModule('ecovacs-deebot', () => ({
  EcoVacsAPI: MockEcoVacsAPI,
}));

// Dynamic import AFTER the mock is registered so the module under test sees the mock
const { default: initializePlugin, EcovacsPlatform, VacuumDevice, MODELS, DEFAULT_MODEL, resolveModel } = await import('../src/module.ts');

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockLog = {
  fatal: jest.fn((message: string, ...parameters: any[]) => {}),

  error: jest.fn((message: string, ...parameters: any[]) => {}),

  warn: jest.fn((message: string, ...parameters: any[]) => {}),

  notice: jest.fn((message: string, ...parameters: any[]) => {}),

  info: jest.fn((message: string, ...parameters: any[]) => {}),

  debug: jest.fn((message: string, ...parameters: any[]) => {}),
} as unknown as AnsiLogger;

const mockMatterbridge: PlatformMatterbridge = {
  systemInformation: {
    ipv4Address: '192.168.1.1',
    ipv6Address: 'fd78:cbf8:4939:746:a96:8277:346f:416e',
    osRelease: 'x.y.z',
    nodeVersion: '22.10.0',
  },
  rootDirectory: path.join('jest', 'EcovacsPlugin'),
  homeDirectory: path.join('jest', 'EcovacsPlugin'),
  matterbridgeDirectory: path.join('jest', 'EcovacsPlugin', '.matterbridge'),
  matterbridgePluginDirectory: path.join('jest', 'EcovacsPlugin', 'Matterbridge'),
  matterbridgeCertDirectory: path.join('jest', 'EcovacsPlugin', '.mattercert'),
  globalModulesDirectory: path.join('jest', 'EcovacsPlugin', 'node_modules'),
  matterbridgeVersion: '3.5.0',
  matterbridgeLatestVersion: '3.5.0',
  matterbridgeDevVersion: '3.5.0',
  bridgeMode: 'bridge',
  restartMode: '',
  aggregatorVendorId: VendorId(0xfff1),
  aggregatorVendorName: 'Matterbridge',
  aggregatorProductId: 0x8000,
  aggregatorProductName: 'Matterbridge aggregator',

  registerVirtualDevice: jest.fn(async (name: string, type: 'light' | 'outlet' | 'switch' | 'mounted_switch', callback: () => Promise<void>) => {}),
  addBridgedEndpoint: jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeBridgedEndpoint: jest.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeAllBridgedEndpoints: jest.fn(async (pluginName: string) => {}),
} as unknown as PlatformMatterbridge;

const mockConfig: PlatformConfig = {
  name: 'matterbridge-ecovacs',
  type: 'DynamicPlatform',
  version: '1.0.0',
  username: 'test@example.com',
  password: 'testpassword',
  country: 'de',
  continent: 'eu',
  debug: false,
  unregisterOnShutdown: false,
};

const loggerLogSpy = jest.spyOn(AnsiLogger.prototype, 'log').mockImplementation((level: string, message: string, ...parameters: any[]) => {});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Matterbridge Ecovacs Plugin', () => {
  let instance: InstanceType<typeof EcovacsPlatform>;

  // The bridged X2 device created by the platform during onStart (typed loosely for private-field access).
  const device = (): any => (instance as any)?.vacuums?.get('test-did');

  beforeAll(() => {
    // Use fake timers so setInterval/setTimeout don't leak; setImmediate stays real
    // so `await new Promise((r) => setImmediate(r))` still works in tests.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  });

  afterAll(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    // Re-initialize mock implementations after clearAllMocks
    MockEcoVacsAPI.mockImplementation(() => mockApi);
    MockEcoVacsAPI.getDeviceId.mockReturnValue('device-id');
    MockEcoVacsAPI.md5.mockImplementation((s: string) => `md5(${s})`);
    mockApi.connect.mockResolvedValue(undefined);
    mockApi.devices.mockResolvedValue([mockVacuumRecord]);
    mockApi.getVacBot.mockReturnValue(mockVacbot);
    mockMqttClient.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      mqttClientHandlers[event] = cb;
    });
    mockVacbot.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      eventHandlers[event] = cb;
    });
    mockVacbot.once.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      eventHandlers[event] = cb;
    });
    mockVacbot.off.mockImplementation(() => {});
    mockVacbot.run.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === 'GetMaps') {
        eventHandlers['CurrentMapMID']?.('test-map-mid');
      } else if (command === 'GetSpotAreas') {
        eventHandlers['MapSpotAreas']?.({ mapSpotAreas: [{ mapSpotAreaID: '0' }, { mapSpotAreaID: '1' }] });
      } else if (command === 'GetSpotAreaInfo') {
        const areaID = String(args[1]);
        eventHandlers['MapSpotAreaInfo']?.({ mapSpotAreaID: areaID, mapSpotAreaName: `Room ${areaID}` });
      }
    });
    mockVacbot.disconnectAsync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    const d = device();
    if (d) {
      // Clear the keepalive interval so Jest can exit cleanly
      if (d.pollTimer) {
        clearInterval(d.pollTimer);
        d.pollTimer = null;
      }
      // Reset selected areas and clean mode between tests
      d.selectedAreaIds = [];
      d.currentCleanMode = 1; // vacuum
      d.currentSpeedMode = null;
      // Reset pause flags
      d.isRobotPaused = false;
      d.resumePending = false;
      // Reset deduplication state so each test starts fresh
      d.lastRunMode = -1;
      d.lastOpState = -1;
      d.lastErrorId = -1;
      d.lastBatChargeState = -1;
      d.lastBatteryPct = 0;
    }
    if (instance) {
      // Reset reconnect/shutdown state so guards don't bleed across tests
      (instance as any).isReconnecting = false;
      (instance as any).reconnectTimer = null;
      (instance as any).isShuttingDown = false;
    }
  });

  // ── Constructor & version check ───────────────────────────────────────────

  it('should throw an error if matterbridge is not the required version', async () => {
    // @ts-expect-error Ignore readonly for testing purposes
    mockMatterbridge.matterbridgeVersion = '2.0.0';
    expect(() => new EcovacsPlatform(mockMatterbridge, mockLog, mockConfig)).toThrow(
      'This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
    // @ts-expect-error Ignore readonly for testing purposes
    mockMatterbridge.matterbridgeVersion = '3.4.0';
  });

  it('should create an instance of the platform', async () => {
    instance = initializePlugin(mockMatterbridge, mockLog, mockConfig);
    (instance as any).setMatterNode(
      (mockMatterbridge as any).addBridgedEndpoint,
      (mockMatterbridge as any).removeBridgedEndpoint,
      (mockMatterbridge as any).removeAllBridgedEndpoints,
      (mockMatterbridge as any).registerVirtualDevice,
    );
    expect(instance).toBeInstanceOf(EcovacsPlatform);
    expect(instance.matterbridge).toBe(mockMatterbridge);
    expect(instance.log).toBe(mockLog);
    expect(instance.config).toBe(mockConfig);
    expect(instance.matterbridge.matterbridgeVersion).toBe('3.4.0');
    expect(mockLog.info).toHaveBeenCalledWith('Initializing Ecovacs Platform...');
  });

  // ── onStart branches ──────────────────────────────────────────────────────

  it('should log an error if credentials are missing', async () => {
    const saved = mockConfig.username;
    (mockConfig as Record<string, unknown>).username = '';
    await instance.onStart('no-creds');
    (mockConfig as Record<string, unknown>).username = saved;
    expect(mockLog.error).toHaveBeenCalledWith('Ecovacs credentials are not configured. Please set username and password in the plugin config.');
  });

  it('should log an error if the Ecovacs connection fails', async () => {
    mockApi.connect.mockRejectedValueOnce(new Error('Network error'));
    await instance.onStart('fail-test');
    expect(mockLog.error).toHaveBeenCalledWith('Failed to connect to Ecovacs cloud: Network error');
  });

  it('should time out and log an error if the Ecovacs cloud call takes too long', async () => {
    // Make api.connect hang forever — never resolves
    mockApi.connect.mockImplementationOnce(() => new Promise((_resolve) => {}));
    const startPromise = instance.onStart('timeout-test');
    // Let the async chain run until connectEcovacs suspends at api.connect (creates the 15s timer)
    await new Promise((resolve) => setImmediate(resolve));
    // Now advance past CLOUD_TIMEOUT_MS (15 s) to fire the rejection timeout callback
    jest.advanceTimersByTime(15_001);
    await new Promise((resolve) => setImmediate(resolve));
    await startPromise;
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Ecovacs auth timed out after 15s'));
  });

  it('should log an error if no devices are returned', async () => {
    mockApi.devices.mockResolvedValueOnce([]);
    await instance.onStart('no-devices-test');
    expect(mockLog.error).toHaveBeenCalledWith('No Ecovacs devices found on this account.');
  });

  it('should map GB country code to UK when connecting', async () => {
    await (instance as any).connectEcovacs({ ...mockConfig, country: 'gb', continent: 'eu' });
    expect(MockEcoVacsAPI).toHaveBeenCalledWith('device-id', 'UK', 'eu');
    // Drop the device created by this direct connect so the next test observes a fresh discovery
    (instance as any).vacuums.clear();
  });

  it('should start, discover the X2 and create its VacuumDevice with the matched profile', async () => {
    await instance.onStart('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: Jest');
    expect(mockLog.info).toHaveBeenCalledWith('Found device: Deebot X2 (class: e6ofmn)');
    expect(mockLog.info).toHaveBeenCalledWith('Using model profile: Deebot X2');
    expect(device()).toBeInstanceOf(VacuumDevice);
    expect(device().definition).toBe(MODELS['e6ofmn']);
    expect(mockVacbot.connect).toHaveBeenCalled();
    await instance.onStart();
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: none');
  });

  it('should warn and fall back to the default profile for an unknown device class', async () => {
    mockApi.devices.mockResolvedValueOnce([{ did: 'unknown-did', name: 'Mystery Bot', class: 'zzzzzz' }]);
    await instance.onStart('unknown-class-test');
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("Unknown Ecovacs device class 'zzzzzz'"));
    const unknown = (instance as any).vacuums.get('unknown-did');
    expect(unknown.definition).toBe(DEFAULT_MODEL);
    // The mock's eventHandlers registry is shared, so the unknown device's attach
    // overwrote the X2 handlers. Drop it and re-attach the X2 so subsequent tests
    // drive the X2 device again.
    (instance as any).vacuums.delete('unknown-did');
    await instance.onStart('restore-x2-handlers');
  });

  // ── fetchSpotAreas branches ───────────────────────────────────────────────

  it('should resolve immediately when spot areas list is empty', async () => {
    device().vacbot = mockVacbot;
    // GetMaps → CurrentMapMID → GetSpotAreas → MapSpotAreas with empty list → finish()
    mockVacbot.run.mockImplementation((command: string) => {
      if (command === 'GetMaps') eventHandlers['CurrentMapMID']?.('test-map-mid');
      else if (command === 'GetSpotAreas') eventHandlers['MapSpotAreas']?.({ mapSpotAreas: [] });
    });
    const rooms = await device().fetchSpotAreas();
    expect(rooms).toEqual([]);
  });

  it('should handle fetchSpotAreas timeout gracefully', async () => {
    device().vacbot = mockVacbot;
    // Make GetMaps a no-op — no events fire, so the 10 s timeout triggers
    mockVacbot.run.mockImplementationOnce(() => {});
    const roomsPromise = device().fetchSpotAreas();
    jest.advanceTimersByTime(10_001);
    const rooms = await roomsPromise;
    expect(rooms).toEqual([]);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('fetchSpotAreas timed out'));
  });

  it('should catch and log errors thrown inside the ready callback', async () => {
    device().vacbot = mockVacbot;
    // Throwing inside the Promise executor of fetchSpotAreas() rejects the promise,
    // which is awaited in the ready callback's try-block → caught and logged.
    mockVacbot.run.mockImplementationOnce(() => {
      throw new Error('GetMaps failed');
    });
    await (eventHandlers['ready'] as () => Promise<void>)();
    expect(mockLog.error).toHaveBeenCalledWith('Failed to set up Matter device: GetMaps failed');
  });

  // ── Ready callback: device setup ──────────────────────────────────────────

  it('should fire the ready callback and create the RVC device', async () => {
    device().vacbot = mockVacbot;
    await (eventHandlers['ready'] as () => Promise<void>)();

    expect(mockVacbot.run).toHaveBeenCalledWith('GetBatteryState');
    expect(mockVacbot.run).toHaveBeenCalledWith('GetChargeState');
    // GetCleanState (getCleanInfo) is not called — X2 rejects it with body.code=20003;
    // CleanReport events are pushed by the robot automatically (cleanStateIsPushOnly).
    expect(mockVacbot.run).not.toHaveBeenCalledWith('GetCleanState');
    expect(mockLog.info).toHaveBeenCalledWith('Deebot X2 registered as Matter RVC device with 2 room(s)');

    // Cover keepalive poll callback (fire the setInterval)
    jest.advanceTimersByTime(90_001);
    expect(mockVacbot.run).toHaveBeenCalledWith('GetBatteryState');

    // Cover vacbot Error event handler body
    eventHandlers['Error']?.('MQTT disconnected');
    expect(mockLog.error).toHaveBeenCalledWith('Vacbot error: MQTT disconnected');

    // Cover early-return branch in onCurrentMapMID (mapMID already set)
    eventHandlers['CurrentMapMID']?.('duplicate-mid');
    // Cover empty-areas branch in onMapSpotAreas (finished=true, finish() is a no-op)
    eventHandlers['MapSpotAreas']?.({ mapSpotAreas: [] });
  });

  it('should not recreate the RVC endpoint when ready fires again after a reconnect', async () => {
    device().vacbot = mockVacbot;
    const rvcBefore = device().rvc;
    expect(rvcBefore).not.toBeNull();
    await (eventHandlers['ready'] as () => Promise<void>)();
    expect(device().rvc).toBe(rvcBefore);
  });

  // ── Event handlers (Ecovacs → Matter) ─────────────────────────────────────

  it('should handle BatteryInfo events at all charge levels', async () => {
    eventHandlers['BatteryInfo']?.(75); // > 20 → Ok (0)
    eventHandlers['BatteryInfo']?.(15); // > 5, ≤ 20 → Warning (1)
    eventHandlers['BatteryInfo']?.(3); //  ≤ 5 → Critical (2)
    await Promise.resolve();
    expect(mockLog.debug).toHaveBeenCalledWith('Battery: 75% (level=0)');
    expect(mockLog.debug).toHaveBeenCalledWith('Battery: 15% (level=1)');
    expect(mockLog.debug).toHaveBeenCalledWith('Battery: 3% (level=2)');
  });

  it('should skip BatteryInfo when rvc is not yet set', async () => {
    const savedRvc = device().rvc;
    device().rvc = null;
    eventHandlers['BatteryInfo']?.(50);
    device().rvc = savedRvc;
    expect(mockLog.debug).not.toHaveBeenCalled();
  });

  it('should handle CleanReport events for all status values', async () => {
    eventHandlers['CleanReport']?.('auto');
    eventHandlers['CleanReport']?.('spot');
    eventHandlers['CleanReport']?.('spot_area');
    eventHandlers['CleanReport']?.('custom_area');
    eventHandlers['CleanReport']?.('pause');
    eventHandlers['CleanReport']?.('returning');
    eventHandlers['CleanReport']?.('stop');
    eventHandlers['CleanReport']?.('idle');
    await Promise.resolve();
    expect(mockLog.info).toHaveBeenCalledWith('CleanReport: auto');
    expect(mockLog.info).toHaveBeenCalledWith('CleanReport: pause');
    expect(mockLog.info).toHaveBeenCalledWith('CleanReport: returning');
    expect(mockLog.info).toHaveBeenCalledWith('CleanReport: stop');
  });

  it('should treat CleanReport(undefined) as spot_area Running (freeClean X2 firmware)', async () => {
    // ecovacs-deebot emits CleanReport(undefined) when the robot reports type='freeClean'
    // because 'freeClean' is not in CLEAN_MODE_FROM_ECOVACS. We normalise it to 'spot_area'.
    eventHandlers['CleanReport']?.(undefined as any);
    await Promise.resolve();
    expect(mockLog.info).toHaveBeenCalledWith('CleanReport: spot_area');
  });

  it('should ignore CleanReport: pause when robot is already charging (stale post-goHome event)', async () => {
    // X2 firmware sends a late CleanReport: pause after goHome completes, marking the
    // interrupted freeClean task as "paused". If lastChargeStatus === 'charging' the robot
    // is already docked — the Paused state must not flash through to HomeKit.
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    device().lastChargeStatus = 'charging';
    eventHandlers['CleanReport']?.('pause');
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalledWith('rvcOperationalState', 'operationalState', 0x02, expect.anything());
    // isRobotPaused must NOT be set for a stale event
    expect(device().isRobotPaused).toBe(false);

    spy.mockRestore();
    device().lastChargeStatus = 'idle';
  });

  it('should ignore CleanReport: washing (mop prewash at station — no state change)', async () => {
    // The all-in-one station emits CleanReport('washing') ~once/second while pre-washing
    // the mop pad before the robot departs. The robot is still docked; no state change.
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    eventHandlers['CleanReport']?.('washing');
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalledWith('rvcOperationalState', 'operationalState', expect.anything(), expect.anything());
    expect(device().isRobotPaused).toBe(false);

    spy.mockRestore();
  });

  it('should ignore stale CleanReport: pause arriving after resume() was sent', async () => {
    // X2 firmware pushes CleanReport: pause with a delay after the pause command.
    // If the user resumes before this push arrives, the event is stale and must be discarded.
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // Set resumePending = true to simulate having just sent resume
    device().resumePending = true;
    eventHandlers['CleanReport']?.('pause');
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalledWith('rvcOperationalState', 'operationalState', 0x02, expect.anything());
    expect(device().resumePending).toBe(false); // flag cleared after discard
    expect(device().isRobotPaused).toBe(false);

    spy.mockRestore();
  });

  it('should not let ChargeState: idle override Paused state when robot is paused on floor', async () => {
    // When the robot is paused mid-clean, ChargeState: idle fires (robot is on the floor).
    // This must NOT override the Paused operationalState with Docked.
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // Simulate robot paused — isRobotPaused=true, lastRunMode=Idle (set by CleanReport: pause)
    device().isRobotPaused = true;
    device().lastRunMode = 1; // Idle (not Cleaning) — so guard doesn't fire

    eventHandlers['ChargeState']?.('idle');
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalledWith('rvcOperationalState', 'operationalState', 0x42, expect.anything());

    spy.mockRestore();
  });

  it('should not let ChargeState override CleanReport while robot is actively cleaning', async () => {
    // Reproduces the real-world bug: dock fires ChargeState('charging') the moment
    // the robot unplugs. With battery=100%, updateChargeState() would set Docked,
    // overriding the CleanReport('auto') state and hiding the clean from HomeKit.
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // Robot starts cleaning → lastRunMode = Cleaning
    eventHandlers['CleanReport']?.('auto');
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith('rvcOperationalState', 'operationalState', 0x01, expect.anything()); // Running

    // Dock fires ChargeState: charging → must be ignored (robot is cleaning)
    spy.mockClear();
    device().lastBatteryPct = 100; // would trigger IsAtFullCharge + Docked if not guarded
    eventHandlers['ChargeState']?.('charging');
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalledWith('rvcOperationalState', 'operationalState', expect.anything(), expect.anything());
    // lastChargeStatus IS still updated (needed for CleanReport default branch later)
    expect(device().lastChargeStatus).toBe('charging');

    spy.mockRestore();
    device().lastChargeStatus = 'idle';
  });

  it('should not call updateChargeState from BatteryInfo while robot is cleaning', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // Robot cleaning → lastRunMode = Cleaning, lastChargeStatus = 'charging'
    eventHandlers['CleanReport']?.('auto');
    await Promise.resolve();
    device().lastChargeStatus = 'charging';
    spy.mockClear();

    // BatteryInfo at 100% should NOT call updateChargeState (would set Docked)
    eventHandlers['BatteryInfo']?.(100);
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalledWith('rvcOperationalState', 'operationalState', expect.anything(), expect.anything());
    expect(spy).not.toHaveBeenCalledWith('powerSource', 'batChargeState', expect.anything(), expect.anything());

    spy.mockRestore();
    device().lastChargeStatus = 'idle';
  });

  it('should handle ChargeState events for all status values', async () => {
    eventHandlers['ChargeState']?.('returning');
    eventHandlers['ChargeState']?.('charging');
    eventHandlers['ChargeState']?.('idle');
    await Promise.resolve();
    expect(mockLog.info).toHaveBeenCalledWith('ChargeState: returning');
    expect(mockLog.info).toHaveBeenCalledWith('ChargeState: charging');
    expect(mockLog.info).toHaveBeenCalledWith('ChargeState: idle');
  });

  it('should set batChargeState=IsCharging(1) when charging below 100%, IsNotCharging(3) otherwise', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // charging at 80% → OP_STATE.Charging + IsCharging (1)
    device().lastBatteryPct = 80;
    eventHandlers['ChargeState']?.('charging');
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith('powerSource', 'batChargeState', 1, expect.anything());
    expect(spy).toHaveBeenCalledWith('rvcOperationalState', 'operationalState', 0x41, expect.anything()); // Charging

    // idle → IsNotCharging (3) — different from previous (1) so attribute fires
    spy.mockClear();
    eventHandlers['ChargeState']?.('idle');
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith('powerSource', 'batChargeState', 3, expect.anything());

    // returning → IsNotCharging (3) — reset dedup counter first so the call fires
    device().lastBatChargeState = -1;
    spy.mockClear();
    eventHandlers['ChargeState']?.('returning');
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith('powerSource', 'batChargeState', 3, expect.anything());

    spy.mockRestore();
    device().lastChargeStatus = 'idle';
  });

  it('should set batChargeState=IsAtFullCharge(2) and OP_STATE.Docked when charging at 100%', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // charging at 100% → OP_STATE.Docked + IsAtFullCharge (2)
    device().lastBatteryPct = 100;
    eventHandlers['ChargeState']?.('charging');
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith('powerSource', 'batChargeState', 2, expect.anything()); // IsAtFullCharge
    expect(spy).toHaveBeenCalledWith('rvcOperationalState', 'operationalState', 0x42, expect.anything()); // Docked

    spy.mockRestore();
    device().lastChargeStatus = 'idle';
  });

  it('should upgrade to IsAtFullCharge when BatteryInfo reaches 100% while charging', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // Robot starts charging at 80%
    device().lastBatteryPct = 80;
    device().lastChargeStatus = 'charging';

    // BatteryInfo fires at 100% → updateChargeState() upgrades to IsAtFullCharge + Docked
    eventHandlers['BatteryInfo']?.(100);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith('powerSource', 'batChargeState', 2, expect.anything()); // IsAtFullCharge
    expect(spy).toHaveBeenCalledWith('rvcOperationalState', 'operationalState', 0x42, expect.anything()); // Docked

    spy.mockRestore();
    device().lastChargeStatus = 'idle';
  });

  it('should not call updateChargeState from BatteryInfo when not charging', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // lastChargeStatus is 'idle' (default) — BatteryInfo should NOT call updateChargeState
    device().lastChargeStatus = 'idle';
    eventHandlers['BatteryInfo']?.(50);
    await Promise.resolve();
    // batChargeState must NOT be set (updateChargeState only called when charging)
    expect(spy).not.toHaveBeenCalledWith('powerSource', 'batChargeState', expect.anything(), expect.anything());

    spy.mockRestore();
  });

  it('should log setAttribute errors in setBatChargeState', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockRejectedValue(new Error('set failed'));
    device().lastBatteryPct = 80; // below 100 so it takes the IsCharging path
    eventHandlers['ChargeState']?.('charging');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('setAttribute powerSource.batChargeState error:'));
    spy.mockRestore();
    device().lastChargeStatus = 'idle';
  });

  it('should handle ErrorCode events — map to RVC error and log warnings', async () => {
    // Known error: 322 → WaterTankEmpty (0x44), logs a warning with description
    eventHandlers['ErrorCode']?.('322');
    await Promise.resolve();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('322'));
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Clean water tank empty'));

    jest.clearAllMocks();

    // Unknown error code → UnableToCompleteOperation (0x02), still logs a warning
    eventHandlers['ErrorCode']?.('999');
    await Promise.resolve();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('999'));

    jest.clearAllMocks();

    // NoError (code 0) → no warning, debug only
    eventHandlers['ErrorCode']?.('0');
    await Promise.resolve();
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.debug).toHaveBeenCalledWith('ErrorCode: 0 (no error / transient)');

    jest.clearAllMocks();

    // Code 323 → DustBinFull (dirty water tank full), logs a warning with description
    eventHandlers['ErrorCode']?.('323');
    await Promise.resolve();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('323'));
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Dirty water tank full'));
  });

  it('should not override Charging with Docked when CleanReport idle fires after ChargeState charging', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // Simulate poll sequence: ChargeState('charging') → then CleanReport('idle')
    eventHandlers['ChargeState']?.('charging');
    eventHandlers['CleanReport']?.('idle');
    await Promise.resolve();

    // Every operationalState setAttribute call should be 0x41 (Charging), never 0x42 (Docked)
    const opStateCalls = spy.mock.calls.filter((c) => c[1] === 'operationalState');
    for (const call of opStateCalls) {
      expect(call[2]).toBe(0x41); // Charging, not Docked (0x42)
    }

    // Same for lastChargeStatus === 'returning'
    spy.mockClear();
    eventHandlers['ChargeState']?.('returning');
    eventHandlers['CleanReport']?.('stop');
    await Promise.resolve();
    const opStateCalls2 = spy.mock.calls.filter((c) => c[1] === 'operationalState');
    for (const call of opStateCalls2) {
      expect(call[2]).toBe(0x40); // SeekingCharger, not Docked (0x42)
    }

    // With lastChargeStatus === 'idle', CleanReport idle → Docked
    spy.mockClear();
    eventHandlers['ChargeState']?.('idle');
    eventHandlers['CleanReport']?.('stop');
    await Promise.resolve();
    const opStateCalls3 = spy.mock.calls.filter((c) => c[1] === 'operationalState');
    const lastDockedCall = opStateCalls3[opStateCalls3.length - 1];
    expect(lastDockedCall?.[2]).toBe(0x42); // Docked

    spy.mockRestore();
  });

  it('should deduplicate setAttribute calls when state values are unchanged', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockResolvedValue(undefined);

    // First CleanReport: new values → both setAttribute calls fire
    eventHandlers['CleanReport']?.('auto'); // Running(1), Cleaning(2)
    await Promise.resolve();
    const firstCallCount = spy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Second identical CleanReport: same values → no setAttribute calls
    spy.mockClear();
    eventHandlers['CleanReport']?.('auto');
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalledWith('rvcRunMode', 'currentMode', expect.anything(), expect.anything());
    expect(spy).not.toHaveBeenCalledWith('rvcOperationalState', 'operationalState', expect.anything(), expect.anything());

    // State change: different values → setAttribute fires again
    spy.mockClear();
    eventHandlers['CleanReport']?.('stop'); // Idle(1), Docked(0x42)
    await Promise.resolve();
    expect(spy).toHaveBeenCalledWith('rvcOperationalState', 'operationalState', 0x42, expect.anything());

    spy.mockRestore();
  });

  it('should log setAttribute errors in BatteryInfo handler', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockRejectedValue(new Error('set failed'));
    eventHandlers['BatteryInfo']?.(75);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('setAttribute batPercentRemaining error:'));
    expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('setAttribute batChargeLevel error:'));
    spy.mockRestore();
  });

  it('should log setAttribute errors in setRvcState', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockRejectedValue(new Error('set failed'));
    eventHandlers['CleanReport']?.('auto');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('setAttribute rvcRunMode.currentMode error:'));
    expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('setAttribute rvcOperationalState.operationalState error:'));
    spy.mockRestore();
  });

  it('should log setAttribute errors in setRvcError', async () => {
    const spy = jest.spyOn(device().rvc, 'setAttribute').mockRejectedValue(new Error('set failed'));
    eventHandlers['ErrorCode']?.('322');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('setAttribute rvcOperationalState.operationalError error:'));
    spy.mockRestore();
  });

  // ── Command handlers (Matter → Ecovacs) ───────────────────────────────────

  it('should forward pause/resume/goHome commands to vacbot', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    await rvc.executeCommandHandler('pause', undefined, 'rvcOperationalState');
    expect(device().isRobotPaused).toBe(true); // pause sets the flag
    await rvc.executeCommandHandler('resume', undefined, 'rvcOperationalState');
    expect(device().isRobotPaused).toBe(false); // resume clears the flag
    await rvc.executeCommandHandler('goHome', undefined, 'rvcOperationalState');
    expect(mockVacbot.pause).toHaveBeenCalled();
    expect(mockVacbot.resume).toHaveBeenCalled();
    // goHome must NOT call stop() before charge() — stop() marks the task as "paused"
    // in the Ecovacs app. Charge is accepted from any state.
    expect(mockVacbot.stop).not.toHaveBeenCalled();
    expect(mockVacbot.charge).toHaveBeenCalled();
  });

  it('should call resume() when changeToMode(non-Idle) arrives while paused', async () => {
    // HomeKit sends SpotCleaning(4) as "resume" after a spot area clean was paused.
    // Our code must call vacbot.resume() rather than startClean().
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    device().isRobotPaused = true;
    await rvc.executeCommandHandler('changeToMode', { newMode: 4 }, 'rvcRunMode');
    expect(mockVacbot.resume).toHaveBeenCalled();
    expect(mockVacbot.run).not.toHaveBeenCalledWith('Clean_V2');
    expect(device().isRobotPaused).toBe(false); // cleared after resume
    expect(device().resumePending).toBe(true); // set so stale CleanReport: pause is discarded
  });

  it('should call startClean() when changeToMode(4) arrives while not paused', async () => {
    // Mode 4 (SpotCleaning) when not paused means start a new spot clean.
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    // isRobotPaused is false (afterEach reset)
    await rvc.executeCommandHandler('changeToMode', { newMode: 4 }, 'rvcRunMode');
    expect(mockVacbot.resume).not.toHaveBeenCalled();
    expect(mockVacbot.run).toHaveBeenCalledWith('Clean_V2');
  });

  it('should log the identify command', async () => {
    const rvc = device().rvc;
    await rvc.executeCommandHandler('identify', { identifyTime: 5 }, 'identify');
    expect(mockLog.info).toHaveBeenCalledWith('Matter command: identify (5s)');
  });

  it('should handle selectAreas command and store selected area IDs', async () => {
    const rvc = device().rvc;
    await rvc.executeCommandHandler('selectAreas', { newAreas: [1, 2] }, 'serviceArea');
    expect(device().selectedAreaIds).toEqual([1, 2]);
    expect(mockLog.info).toHaveBeenCalledWith('Matter command: selectAreas → [1, 2]');
  });

  it('should stop the vacbot when RunMode is set to Idle', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    await rvc.executeCommandHandler('changeToMode', { newMode: 1 }, 'rvcRunMode');
    expect(mockVacbot.stop).toHaveBeenCalled();
  });

  it('should start a Vacuum clean (setWorkMode 1, never setSweepMode)', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    await rvc.executeCommandHandler('changeToMode', { newMode: 1 }, 'rvcCleanMode');
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcRunMode');
    // Work mode is pinned before every clean so state left by the Ecovacs app
    // (e.g. mopping enabled) can never leak into a HomeKit-initiated run.
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 1 });
    expect(mockVacbot.run).toHaveBeenCalledWith('Clean_V2');
    // setSweepMode is a scrubbing toggle whose mere invocation triggers a mop-pad
    // wash at the Omni station — the plugin must never send it.
    expect(mockVacbot.run).not.toHaveBeenCalledWith('DisableSweepMode');
    expect(mockVacbot.run).not.toHaveBeenCalledWith('EnableSweepMode');
  });

  it('should start a Mop clean (setWorkMode 2 + Clean_V2)', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcCleanMode');
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcRunMode');
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 2 });
    expect(mockVacbot.run).toHaveBeenCalledWith('Clean_V2');
  });

  it('should start a Vacuum & Mop simultaneous clean (setWorkMode 0)', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    await rvc.executeCommandHandler('changeToMode', { newMode: 3 }, 'rvcCleanMode');
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcRunMode');
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 0 });
    expect(mockVacbot.run).toHaveBeenCalledWith('Clean_V2');
  });

  it('should start a Mop after Vacuum (sequential) clean (setWorkMode 3)', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    await rvc.executeCommandHandler('changeToMode', { newMode: 4 }, 'rvcCleanMode');
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcRunMode');
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 3 });
    expect(mockVacbot.run).toHaveBeenCalledWith('Clean_V2');
  });

  it('should clean selected spot areas when areas are selected (freeClean)', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    // Select areas 1 and 2 (mapped to Ecovacs IDs '0' and '1')
    await rvc.executeCommandHandler('selectAreas', { newAreas: [1, 2] }, 'serviceArea');
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcRunMode');
    // Vacuum-only: work mode pinned to 1, and setSweepMode never sent (pad-wash trigger).
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 1 });
    expect(mockVacbot.run).not.toHaveBeenCalledWith('DisableSweepMode');
    // Areas 1,2 (Matter IDs) map to Ecovacs IDs '0','1'; freeClean value = "1,0;1,1"
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'clean_V2', {
      act: 'start',
      content: { count: 1, donotClean: '', type: 'freeClean', value: '1,0;1,1' },
      mode: '',
      router: 'plan',
    });
  });

  it('should set mop work mode for Mop spot area clean', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcCleanMode'); // Mop
    await rvc.executeCommandHandler('selectAreas', { newAreas: [1] }, 'serviceArea');
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcRunMode');
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 2 });
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'clean_V2', expect.objectContaining({ act: 'start' }));
  });

  it('should set combined work mode for VacuumAndMop spot area clean', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    await rvc.executeCommandHandler('changeToMode', { newMode: 3 }, 'rvcCleanMode'); // VacuumAndMop
    await rvc.executeCommandHandler('selectAreas', { newAreas: [1] }, 'serviceArea');
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcRunMode');
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 0 });
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'clean_V2', expect.objectContaining({ act: 'start' }));
  });

  it('should store speed mode without affecting clean type mode', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    // Set Mop as type mode first
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcCleanMode');
    expect(device().currentCleanMode).toBe(2); // Mop

    // Now select Quiet speed mode (10) — must NOT overwrite currentCleanMode
    await rvc.executeCommandHandler('changeToMode', { newMode: 10 }, 'rvcCleanMode');
    expect(device().currentSpeedMode).toBe(10); // Quiet
    expect(device().currentCleanMode).toBe(2); // still Mop
  });

  it('should call SetCleanSpeed before cleaning when a speed mode is set', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;

    // Quiet (10) → level 1 (silent)
    await rvc.executeCommandHandler('changeToMode', { newMode: 10 }, 'rvcCleanMode');
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcRunMode');
    expect(mockVacbot.run).toHaveBeenCalledWith('SetCleanSpeed', 1);
    expect(mockVacbot.run).toHaveBeenCalledWith('Clean_V2');
  });

  it('should send correct SetCleanSpeed level for each speed mode', async () => {
    device().vacbot = mockVacbot;

    const cases: [number, number][] = [
      [10, 1], // Quiet → silent
      [11, 2], // Automatic → normal
      [12, 3], // Quick → high
      [13, 4], // Deep Clean → very high
    ];
    for (const [speedMode, expectedLevel] of cases) {
      jest.clearAllMocks();
      device().currentSpeedMode = speedMode;
      device().startClean();
      expect(mockVacbot.run).toHaveBeenCalledWith('SetCleanSpeed', expectedLevel);
    }
  });

  it('should not call SetCleanSpeed when no speed mode is set', async () => {
    const rvc = device().rvc;
    device().vacbot = mockVacbot;
    // currentSpeedMode is null (reset by afterEach)
    await rvc.executeCommandHandler('changeToMode', { newMode: 2 }, 'rvcRunMode');
    expect(mockVacbot.run).not.toHaveBeenCalledWith('SetCleanSpeed', expect.anything());
  });

  it('should be a no-op in startClean when vacbot is null', async () => {
    device().vacbot = null;
    expect(() => device().startClean()).not.toThrow();
    device().vacbot = mockVacbot;
  });

  // ── Reconnection & keepalive robustness ──────────────────────────────────

  it('should clear reconnectTimer on shutdown', async () => {
    (instance as any).reconnectTimer = setTimeout(() => {}, 1_000_000);
    await instance.onShutdown('timer-clear-test');
    expect((instance as any).reconnectTimer).toBeNull();
  });

  it('should register MQTT close handler and schedule reconnect on close', async () => {
    await instance.onStart('mqtt-close-test');
    // The close handler should have been registered on the mock MQTT client
    expect(mqttClientHandlers['close']).toBeDefined();
    // Fire the close event — should log a warning and set isReconnecting
    mqttClientHandlers['close']?.();
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('MQTT connection closed'));
    expect((instance as any).isReconnecting).toBe(true);
  });

  it('should log keepalive poll errors without crashing', async () => {
    device().vacbot = mockVacbot;
    await (eventHandlers['ready'] as () => Promise<void>)();
    mockVacbot.run.mockImplementationOnce(() => {
      throw new Error('mqtt send error');
    });
    jest.advanceTimersByTime(90_001);
    expect(mockLog.debug).toHaveBeenCalledWith(expect.stringContaining('Keepalive poll error'));
  });

  it('should no-op in scheduleReconnect when shutdown raced the timer', async () => {
    const cfg = { ...mockConfig } as any;
    instance.scheduleReconnect(cfg);
    expect((instance as any).isReconnecting).toBe(true);
    // Second call is a no-op while first is pending
    instance.scheduleReconnect(cfg);
    // Simulate shutdown winning the race
    (instance as any).isShuttingDown = true;
    jest.advanceTimersByTime(30_001);
    await new Promise((resolve) => setImmediate(resolve));
    // No reconnect should have been attempted
    expect(mockApi.connect).not.toHaveBeenCalled();
  });

  it('should reconnect after MQTT close delay, detach vacbots and clear pollTimer', async () => {
    device().vacbot = mockVacbot;
    // Ensure a pollTimer is set so the detach clear branch is exercised
    device().pollTimer = setInterval(() => {}, 1_000_000);
    const cfg = { ...mockConfig } as any;
    instance.scheduleReconnect(cfg);
    jest.advanceTimersByTime(30_001);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLog.info).toHaveBeenCalledWith('Attempting Ecovacs reconnect...');
    expect(mockVacbot.disconnectAsync).toHaveBeenCalled();
    expect(device().pollTimer).toBeNull();
    expect(mockApi.connect).toHaveBeenCalled();
  });

  it('should retry scheduleReconnect when reconnect attempt fails', async () => {
    device().vacbot = mockVacbot;
    mockApi.connect.mockRejectedValueOnce(new Error('cloud down'));
    const cfg = { ...mockConfig } as any;
    instance.scheduleReconnect(cfg);
    jest.advanceTimersByTime(30_001);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Reconnect failed'));
    // A new reconnect should be scheduled
    expect((instance as any).isReconnecting).toBe(true);
  });

  // ── Lifecycle methods ─────────────────────────────────────────────────────

  it('should configure', async () => {
    await instance.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('onConfigure called');
  });

  it('should change logger level', async () => {
    await instance.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith('onChangeLoggerLevel called with: debug');
  });

  it('should shutdown and disconnect vacbot', async () => {
    device().vacbot = mockVacbot;
    // Set a timer so detach exercises the clearInterval branch
    device().pollTimer = setInterval(() => {}, 1_000_000);
    await instance.onShutdown('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: Jest');
    expect(mockVacbot.disconnectAsync).toHaveBeenCalled();
  });

  it('should fall back to disconnect() when disconnectAsync fails', async () => {
    device().vacbot = mockVacbot;
    mockVacbot.disconnectAsync.mockRejectedValueOnce(new Error('disconnect failed'));
    await instance.onShutdown('fallback-test');
    expect(mockVacbot.disconnect).toHaveBeenCalled();
  });

  it('should unregister devices on shutdown when configured', async () => {
    mockConfig.unregisterOnShutdown = true;
    await instance.onShutdown();
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: none');
    expect((mockMatterbridge as any).removeAllBridgedEndpoints).toHaveBeenCalled();
    mockConfig.unregisterOnShutdown = false;
  });

  // ── Model registry ─────────────────────────────────────────────────────────

  describe('model registry', () => {
    it('resolves the X2 family by canonical device class', () => {
      const { definition, matched } = resolveModel('e6ofmn');
      expect(matched).toBe(true);
      expect(definition.name).toBe('Deebot X2');
      expect(definition.spotAreaStrategy).toBe('freeClean');
      expect(definition.cleanStateIsPushOnly).toBe(true);
    });

    it('resolves X2 alias device classes to the same definition', () => {
      for (const alias of ['lf3bn4', 'e6rcnf', 'ip3mmy', 'p7l7iu']) {
        const { definition, matched } = resolveModel(alias);
        expect(matched).toBe(true);
        expect(definition).toBe(MODELS['e6ofmn']);
      }
    });

    it('falls back to the default profile for unknown or missing device classes', () => {
      expect(resolveModel('does-not-exist')).toEqual({ definition: DEFAULT_MODEL, matched: false });
      expect(resolveModel(undefined)).toEqual({ definition: DEFAULT_MODEL, matched: false });
    });
  });

  // ── VacuumDevice with non-X2 profiles ──────────────────────────────────────

  describe('VacuumDevice with other model profiles', () => {
    // Create a standalone device with a mock vacbot and two mapped rooms.
    const makeDevice = (definition: any): any => {
      const d: any = new VacuumDevice(instance, mockLog, { did: 'other-did', name: 'Generic Bot' }, definition);
      d.vacbot = mockVacbot;
      d.spotAreaMap = new Map([
        [1, '0'],
        [2, '1'],
      ]);
      return d;
    };

    it('uses SpotArea_V2 for room cleans on the default profile (no work-mode command sent)', () => {
      const d = makeDevice(DEFAULT_MODEL);
      d.selectedAreaIds = [1, 2];
      d.startClean();
      expect(mockVacbot.run).toHaveBeenCalledWith('SpotArea_V2', '0,1', 1);
      expect(mockVacbot.run).not.toHaveBeenCalledWith('Generic', 'setWorkMode', expect.anything());
    });

    it('polls GetCleanState on models where clean state is not push-only', () => {
      const d = makeDevice(DEFAULT_MODEL);
      d.pollState();
      expect(mockVacbot.run).toHaveBeenCalledWith('GetCleanState');
    });

    it('uses the legacy SpotArea command and pins the work mode when the model declares workMode', () => {
      const d = makeDevice({
        ...DEFAULT_MODEL,
        cleanCommand: 'Clean',
        spotAreaStrategy: 'SpotArea',
        cleanTypeStrategy: 'workMode',
        cleanModes: ['vacuum', 'mop'],
      });
      d.selectedAreaIds = [1, 2];
      d.startClean();
      expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 1 });
      expect(mockVacbot.run).toHaveBeenCalledWith('SpotArea', 'start', '0,1');

      // Full clean uses the legacy Clean command
      jest.clearAllMocks();
      d.selectedAreaIds = [];
      d.startClean();
      expect(mockVacbot.run).toHaveBeenCalledWith('Clean');

      // Mop mode pins work mode 2
      jest.clearAllMocks();
      d.currentCleanMode = 2; // mop
      d.startClean();
      expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 2 });
    });

    it('ignores selected areas and starts a full clean when spotAreaStrategy is none', () => {
      const d = makeDevice({ ...DEFAULT_MODEL, spotAreaStrategy: 'none' });
      d.selectedAreaIds = [1];
      d.startClean();
      expect(mockVacbot.run).toHaveBeenCalledWith('Clean_V2');
      expect(mockVacbot.run).not.toHaveBeenCalledWith('SpotArea_V2', expect.anything(), expect.anything());
    });

    it('skips the room clean and starts a full clean when no selected area maps to an Ecovacs ID', () => {
      const d = makeDevice(DEFAULT_MODEL);
      d.selectedAreaIds = [99]; // not in spotAreaMap
      d.startClean();
      expect(mockVacbot.run).toHaveBeenCalledWith('Clean_V2');
      expect(mockVacbot.run).not.toHaveBeenCalledWith('SpotArea_V2', expect.anything(), expect.anything());
    });

    it('falls back to the model family name when the account provides no nickname', () => {
      const d = makeDevice(DEFAULT_MODEL);
      expect(d.name).toBe('Generic Bot');
      const unnamed: any = new VacuumDevice(instance, mockLog, { did: 'x' }, DEFAULT_MODEL);
      expect(unnamed.name).toBe('Ecovacs Vacuum');
    });
  });
});
