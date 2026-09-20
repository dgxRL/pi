// Ported from packages/chord/test/facets.test.ts, pruned to the facet lifecycle
// main flow of the reduced copy: provide/use dependency resolution and
// activation ordering, per-instance observations, provideMany keyed spawning,
// environment replicated state, env.own disposal ordering, and one basic
// provider reload.
// Dropped: multi-source/remote-catalogue hosts (the RemoteServiceSource
// machinery is dropped from the reduced copy), keyed publication-failure host
// termination, process-local keyed services, scoped singleton view error-path
// coverage, and the combined remote-catalogue generation tests.

import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context.ts";
import {
	createFacetHost,
	createLoopbackServiceTransport,
	createRemoteServiceBinding,
	defineFacet,
	defineService,
	type Context,
	type MutableReplicatedState,
	type ReplicatedState,
} from "../src/index.ts";
// The reduced FacetHost narrows services to RemoteServices; the loopback needs
// the serving provider, which host.services is at runtime.

interface Source {
	read(context: Context): Promise<string>;
}

interface Projection {
	read(context: Context): Promise<string>;
}

interface KeyedValue {
	read(context: Context): Promise<string>;
}

interface Watched {
	readonly state: ReplicatedState<{ value: number }>;
}

const Source = defineService<Source>("test.experimental.source");
const Projection = defineService<Projection>("test.experimental.projection");
const KeyedValue = defineService<KeyedValue>("test.experimental.keyed-value");
const Watched = defineService<Watched>("test.experimental.watched");

describe("facet host", () => {
	test("discovers setup dependencies before connecting stable service handles", async () => {
		const trace: string[] = [];
		let sourceHandle: Source | undefined;
		const projection = defineFacet({
			id: "projection",
			setup(env) {
				trace.push("setup projection");
				sourceHandle = env.use(Source);
				expect(() => sourceHandle!.read(BACKGROUND_CONTEXT)).toThrow(
					"Facet projection service handles cannot be used while setting_up",
				);
				env.provide(Projection, {
					read: (context) => sourceHandle!.read(context),
				});
				env.onActivate(() => {
					trace.push("activate projection");
				});
				env.onDeactivate(() => {
					trace.push("dispose projection");
				});
			},
		});
		const source = defineFacet({
			id: "source",
			setup(env) {
				trace.push("setup source");
				env.provide(Source, {
					async read() {
						return "value";
					},
				});
				env.onActivate(() => {
					trace.push("activate source");
				});
				env.onDeactivate(() => {
					trace.push("dispose source");
				});
			},
		});
		const host = await createFacetHost({ facets: [projection, source] });

		expect(trace).toEqual(["setup projection", "setup source", "activate source", "activate projection"]);
		expect(await sourceHandle!.read(BACKGROUND_CONTEXT)).toBe("value");
		expect(await host.services.use(Projection).read(BACKGROUND_CONTEXT)).toBe("value");

		await host.dispose();
		expect(trace.slice(-2)).toEqual(["dispose projection", "dispose source"]);
	});

	test("connects keyed observations only when the observing facet activates", async () => {
		const trace: string[] = [];
		const observer = defineFacet({
			id: "observer",
			setup(env) {
				env.observe(KeyedValue, async (service, context) => {
					trace.push(`observe ${await service.read(context)}`);
				});
				env.onActivate(() => {
					trace.push("activate observer");
				});
			},
		});
		const provider = defineFacet({
			id: "provider",
			setup(env) {
				const values = env.provideMany(KeyedValue);
				env.onActivate(() => {
					trace.push("activate provider");
					values.spawn("one", {
						async read() {
							return "one";
						},
					});
				});
			},
		});
		const host = await createFacetHost({ facets: [observer, provider] });
		await vi.waitFor(() => expect(trace).toContain("observe one"));

		expect(trace).toEqual(["activate provider", "activate observer", "observe one"]);
		const remoteServices = createRemoteServiceBinding({
			services: [KeyedValue],
			transport: createLoopbackServiceTransport(host.services),
		});
		const remoteValues: string[] = [];
		remoteServices.observe(KeyedValue, async (service, context) => {
			remoteValues.push(await service.read(context));
		});
		await remoteServices.ready(BACKGROUND_CONTEXT);
		await vi.waitFor(() => expect(remoteValues).toEqual(["one"]));

		await remoteServices.dispose(BACKGROUND_CONTEXT);
		await host.dispose();
	});

	test("rejects missing dependencies, cycles, and asynchronous setup", async () => {
		let activated = false;
		const missing = defineFacet({
			id: "missing",
			setup(env) {
				env.use(Source);
				env.onActivate(() => {
					activated = true;
				});
			},
		});
		await expect(createFacetHost({ facets: [missing] })).rejects.toThrow(
			"Facet missing requires local/test.experimental.source/singleton, but no facet provides it",
		);
		expect(activated).toBe(false);

		const first = defineFacet({
			id: "first",
			setup(env) {
				env.use(Projection);
				env.provide(Source, {
					async read() {
						return "first";
					},
				});
			},
		});
		const second = defineFacet({
			id: "second",
			setup(env) {
				env.use(Source);
				env.provide(Projection, {
					async read() {
						return "second";
					},
				});
			},
		});
		await expect(createFacetHost({ facets: [first, second] })).rejects.toThrow(
			"Facet dependency cycle: first, second",
		);

		const asynchronous = defineFacet({
			id: "asynchronous",
			async setup() {
				await Promise.resolve();
			},
		});
		await expect(createFacetHost({ facets: [asynchronous] })).rejects.toThrow(
			"Facet asynchronous setup must be synchronous",
		);
	});

	test("owns resources registered during activation", async () => {
		let state: MutableReplicatedState<{ value: number }> | undefined;
		let deliveries = 0;
		const consumer = defineFacet({
			id: "consumer",
			setup(env) {
				const watched = env.use(Watched);
				env.onActivate(() => {
					env.own(
						watched.state.subscribe(() => {
							deliveries += 1;
						}),
					);
				});
			},
		});
		const provider = defineFacet({
			id: "provider",
			setup(env) {
				state = env.replicatedState({ value: 0 });
				env.provide(Watched, { state });
			},
		});
		const host = await createFacetHost({ facets: [consumer, provider] });
		expect(deliveries).toBe(1);
		state!.state.value = 1;
		state!.publish(BACKGROUND_CONTEXT);
		expect(deliveries).toBe(2);

		await host.dispose();
		state!.state.value = 2;
		state!.publish(BACKGROUND_CONTEXT);
		expect(deliveries).toBe(2);
	});

	test("keeps remotely exposable local state replicas stable across provider reloads", async () => {
		const sources: MutableReplicatedState<{ value: number }>[] = [];
		const revisions: number[] = [];
		let watched: Watched | undefined;
		const consumer = defineFacet({
			id: "state-consumer",
			setup(env) {
				watched = env.use(Watched);
				env.onActivate(() => {
					env.own(watched!.state.subscribe(({ value }) => revisions.push(value)));
				});
			},
		});
		const provider = (value: number) =>
			defineFacet({
				id: "state-provider",
				setup(env) {
					const state = env.replicatedState({ value });
					sources.push(state);
					env.provide(Watched, { state });
				},
			});
		const host = await createFacetHost({ facets: [consumer, provider(1)] });
		const retainedState = watched!.state;
		expect(retainedState.value).toEqual({ value: 1 });
		expect(revisions).toEqual([1]);

		await host.reload([provider(2)]);
		expect(watched!.state).toBe(retainedState);
		expect(retainedState.value).toEqual({ value: 2 });
		expect(revisions).toEqual([1, 2]);
		sources[0]!.state.value = 3;
		sources[0]!.publish(BACKGROUND_CONTEXT);
		expect(retainedState.value).toEqual({ value: 2 });
		expect(revisions).toEqual([1, 2]);

		await host.dispose();
		expect(() => retainedState.value).toThrow("Facet state-consumer service handles cannot be used while dead");
	});
});
