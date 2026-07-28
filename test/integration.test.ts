/**
 * Matter integration tests.
 *
 * These host the plugin on a real Matterbridge ServerNode and drive it through
 * the Matter cluster servers — the same path a controller such as Apple Home
 * takes — rather than calling the plugin's command handlers directly.
 *
 * That distinction matters: the unit tests in module.test.ts call handlers in
 * isolation and cannot see Matterbridge's own cluster servers, which run inside
 * the same command invocation and write the same attributes. This layer caught
 * the regression where the plugin answered `Cleaning` to a `SpotCleaning`
 * request, which made Apple Home treat its request as not having taken effect
 * so the vacuum never showed as cleaning.
 *
 * Only the Ecovacs cloud is mocked; the Matter side is real.
 *
 * Known gap: commands are invoked through `endpoint.act()`, which acquires
 * behaviour locks asynchronously. A real controller arrives via the protocol
 * layer, which acquires them synchronously — that is how the
 * `[synchronous-transaction-conflict]` failure (every command reporting "could
 * not complete" in HomeKit) was produced, and it does NOT reproduce here.
 * Covering that would need a commissioned matter.js ClientNode driving the
 * server over the wire.
 */

import { jest } from '@jest/globals';
import { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import {
  addMatterbridgePlatform,
  createMatterbridgeEnvironment,
  destroyMatterbridgeEnvironment,
  flushAsync,
  startMatterbridgeEnvironment,
  stopMatterbridgeEnvironment,
} from 'matterbridge/jestutils';
import { AnsiLogger } from 'matterbridge/logger';

// ── Mock the Ecovacs cloud only ───────────────────────────────────────────────

const eventHandlers: Record<string, (...args: unknown[]) => void> = {};

const mockVacbot = {
  connect: jest.fn(),
  ecovacs: { client: { on: jest.fn() } },
  on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    eventHandlers[event] = cb;
  }),
  run: jest.fn((command: string, ...args: unknown[]) => {
    if (command === 'GetMaps') eventHandlers['CurrentMapMID']?.('map-1');
    // Real robots number their areas from 1, so Matter IDs start at 2 — which is
    // what caught the ServiceArea cluster refusing to initialise when currentArea
    // was left at Matterbridge's default of 1.
    else if (command === 'GetSpotAreas') eventHandlers['MapSpotAreas']?.({ mapSpotAreas: [{ mapSpotAreaID: '1' }, { mapSpotAreaID: '2' }] });
    else if (command === 'GetSpotAreaInfo') eventHandlers['MapSpotAreaInfo']?.({ mapSpotAreaID: String(args[1]), mapSpotAreaName: `Room ${String(args[1])}` });
  }),
  pause: jest.fn(),
  resume: jest.fn(),
  charge: jest.fn(),
  stop: jest.fn(),
  disconnect: jest.fn(),
  disconnectAsync: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

const mockApi = {
  connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  devices: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([{ did: 'test-did', nick: 'Deedee', class: 'e6ofmn' }]),
  getVacBot: jest.fn().mockReturnValue(mockVacbot),
  uid: 'uid',
  resource: 'res',
  user_access_token: 'token',
};

jest.unstable_mockModule('ecovacs-deebot', () => ({
  EcoVacsAPI: Object.assign(
    jest.fn().mockImplementation(() => mockApi),
    { getDeviceId: jest.fn().mockReturnValue('device-id'), md5: jest.fn((s: string) => `md5(${s})`), REALM: 'ecouser.net' },
  ),
}));

const { EcovacsPlatform } = await import('../src/module.ts');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** RvcOperationalState values used in assertions. */
const OP = { Running: 0x01, Paused: 0x02, SeekingCharger: 0x40, Charging: 0x41, Docked: 0x42 } as const;
/** RvcRunMode values used in assertions. */
const RUN = { Idle: 1, Cleaning: 2, SpotCleaning: 4 } as const;

describe('Matter integration', () => {
  let platform: InstanceType<typeof EcovacsPlatform>;
  // The RVC endpoint as registered on the real aggregator.
  let rvc: any;

  const config: PlatformConfig = {
    name: 'matterbridge-ecovacs',
    type: 'DynamicPlatform',
    version: '1.0.0',
    username: 'test@example.com',
    password: 'secret',
    country: 'gb',
    continent: 'eu',
    deviceId: 'test-device-id',
    debug: false,
    unregisterOnShutdown: false,
  };

  // Read an attribute straight off the endpoint, as a controller subscription would.
  const attr = (cluster: string, name: string): unknown => rvc.getAttribute(cluster, name);

  // Invoke a cluster command the way a Matter controller does.
  const invoke = async (cluster: string, command: string, params?: Record<string, unknown>): Promise<void> => {
    await rvc.invokeBehaviorCommand(cluster, command, params);
    await flushAsync();
  };

  beforeAll(async () => {
    const matterbridge = await createMatterbridgeEnvironment('EcovacsIntegration');
    await startMatterbridgeEnvironment(5560);

    platform = new EcovacsPlatform(matterbridge as unknown as PlatformMatterbridge, new AnsiLogger({ logName: 'EcovacsIntegration' }), config);
    addMatterbridgePlatform(platform, 'matterbridge-ecovacs');

    await platform.onStart('integration');
    // The plugin builds its endpoint from the vacbot's 'ready' event
    await (eventHandlers['ready'] as () => Promise<void>)();
    await flushAsync();

    rvc = platform.getDevices()[0];
    // Real timings would make every test wait; the settle contract itself is
    // covered by a unit test with fake timers.
    (platform.vacuums.get('test-did') as any).commandSettleMs = 0;
  }, 60_000);

  afterAll(async () => {
    await platform.onShutdown('integration');
    await stopMatterbridgeEnvironment();
    await destroyMatterbridgeEnvironment();
  }, 60_000);

  beforeEach(async () => {
    mockVacbot.run.mockClear();
    mockVacbot.charge.mockClear();
    // Start every test from a known docked-and-idle state. Without this the
    // plugin's de-duplication can suppress a write that a previous test already
    // made, hiding whether this test's scenario produces the right value.
    eventHandlers['CleanReport']?.('idle');
    eventHandlers['ChargeState']?.('charging');
    eventHandlers['BatteryInfo']?.(80);
    await flushAsync();
  });

  it('registers the robot as an RVC device with its rooms', () => {
    expect(rvc).toBeDefined();
    expect(rvc.deviceName).toBe('Deedee');
    const areas = attr('serviceArea', 'supportedAreas') as { areaId: number; areaInfo: { locationInfo: { locationName: string } } }[];
    expect(areas.map((a) => a.areaInfo.locationInfo.locationName)).toEqual(['Room 1', 'Room 2']);
    // Area IDs come from the Ecovacs area, not the order the details arrived in,
    // so a controller's saved selection keeps meaning the same room.
    expect(areas.map((a) => a.areaId)).toEqual([2, 3]);
    // The endpoint must actually be usable: a currentArea outside supportedAreas
    // makes the ServiceArea cluster refuse to initialise, and every later write
    // then fails with "endpoint is in the inactive state".
    expect(rvc.construction.status).toBe('active');
  });

  it('starts a clean and settles on Cleaning/Running', async () => {
    await invoke('rvcRunMode', 'changeToMode', { newMode: RUN.Cleaning });

    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'setWorkMode', { mode: 1 });
    expect(mockVacbot.run).toHaveBeenCalledWith('Clean_V2');
    expect(attr('rvcOperationalState', 'operationalState')).toBe(OP.Running);
    expect(attr('rvcRunMode', 'currentMode')).toBe(RUN.Cleaning);
  });

  it('keeps the run mode the controller asked for', async () => {
    expect(attr('rvcRunMode', 'currentMode')).toBe(RUN.Idle); // precondition
    // Regression: Apple Home requests SpotCleaning when rooms are selected.
    // Reporting Cleaning back made it treat the request as not having taken.
    // Assert on what the plugin writes, not only the settled attribute: the
    // controller sees every intermediate value, and it was the plugin writing
    // Cleaning over Matterbridge's SpotCleaning that made Home give up.
    const writes = jest.spyOn(rvc, 'setAttribute');
    await invoke('serviceArea', 'selectAreas', { newAreas: [3] });
    await invoke('rvcRunMode', 'changeToMode', { newMode: RUN.SpotCleaning });
    expect(writes).not.toHaveBeenCalledWith('rvcRunMode', 'currentMode', RUN.Cleaning, expect.anything());

    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'clean_V2', {
      act: 'start',
      content: { count: 1, donotClean: '', type: 'freeClean', value: '1,2' },
      mode: '',
      router: 'plan',
    });
    expect(attr('rvcRunMode', 'currentMode')).toBe(RUN.SpotCleaning);
    expect(attr('rvcOperationalState', 'operationalState')).toBe(OP.Running);

    // Apple Home compares CurrentArea with SelectedAreas to tell "cleaning this
    // room" from "travelling to it". The robot has not reported arriving yet, so
    // it is genuinely still travelling.
    expect(attr('serviceArea', 'currentArea')).toBeNull();

    // Once it reports the room it is in, that becomes the serviced area
    eventHandlers['DeebotPosition']?.({ currentSpotAreaID: '2' });
    await flushAsync();
    expect(attr('serviceArea', 'currentArea')).toBe(3);

    // The robot's own report must not downgrade the mode to plain Cleaning
    eventHandlers['CleanReport']?.('spot_area');
    await flushAsync();
    expect(writes).not.toHaveBeenCalledWith('rvcRunMode', 'currentMode', RUN.Cleaning, expect.anything());
    expect(attr('rvcRunMode', 'currentMode')).toBe(RUN.SpotCleaning);
    writes.mockRestore();
  });

  it('pauses and resumes with the V2 commands', async () => {
    await invoke('rvcOperationalState', 'pause');
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'clean_V2', { act: 'pause', content: { type: '' } });
    expect(attr('rvcOperationalState', 'operationalState')).toBe(OP.Paused);

    await invoke('rvcOperationalState', 'resume');
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'clean_V2', { act: 'resume', content: { type: '' } });
    expect(attr('rvcOperationalState', 'operationalState')).toBe(OP.Running);
  });

  it('ends the job and docks on goHome', async () => {
    await invoke('rvcOperationalState', 'goHome');
    expect(mockVacbot.run).toHaveBeenCalledWith('Generic', 'clean_V2', { act: 'stop', content: { type: '' } });
    expect(mockVacbot.charge).toHaveBeenCalled();

    // The robot confirms, and the dock takes over the reported state
    eventHandlers['CleanReport']?.('returning');
    await flushAsync();
    expect(attr('rvcOperationalState', 'operationalState')).toBe(OP.SeekingCharger);

    eventHandlers['ChargeState']?.('charging');
    eventHandlers['BatteryInfo']?.(80);
    eventHandlers['CleanReport']?.('idle');
    await flushAsync();
    expect(attr('rvcOperationalState', 'operationalState')).toBe(OP.Charging);
    expect(attr('rvcRunMode', 'currentMode')).toBe(RUN.Idle);
  });

  it('clears the serviced area when the robot stops cleaning', async () => {
    await invoke('serviceArea', 'selectAreas', { newAreas: [2] });
    await invoke('rvcRunMode', 'changeToMode', { newMode: RUN.SpotCleaning });
    eventHandlers['DeebotPosition']?.({ currentSpotAreaID: '1' });
    await flushAsync();
    expect(attr('serviceArea', 'currentArea')).toBe(2);

    eventHandlers['CleanReport']?.('idle');
    eventHandlers['ChargeState']?.('charging');
    await flushAsync();
    expect(attr('serviceArea', 'currentArea')).toBeNull();
  });

  it("does not report the library's internal errors as a device fault", async () => {
    // ecovacs-deebot signals its own failures with negative codes; surfacing
    // them put the endpoint into Error, which controllers show as an alert.
    eventHandlers['CleanReport']?.('auto');
    await flushAsync();
    eventHandlers['ErrorCode']?.('-2');
    await flushAsync();
    expect((attr('rvcOperationalState', 'operationalError') as { errorStateId: number }).errorStateId).toBe(0);
    expect(attr('rvcOperationalState', 'operationalState')).toBe(OP.Running);
  });

  it('does not let a mop-pad wash disturb the reported state', async () => {
    eventHandlers['CleanReport']?.('auto');
    await flushAsync();
    expect(attr('rvcOperationalState', 'operationalState')).toBe(OP.Running);

    for (let i = 0; i < 5; i++) eventHandlers['CleanReport']?.('washing');
    await flushAsync();
    expect(attr('rvcOperationalState', 'operationalState')).toBe(OP.Running);
  });
});
