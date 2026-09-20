// Ported from packages/chord/test/services.test.ts, pruned to the main flows of
// the reduced copy: loopback call round trips, singleton/keyed lifecycle and
// replicated-state hydration over provider subscriptions, RemoteServiceError
// propagation, and rebind/bound semantics.
// Dropped: wire-encoding and state-codec coverage (both codecs are dropped from
// the reduced copy), JSON contract compile-time checks, reconnect/backoff and
// error-taxonomy edge cases, listener-failure ordering/buffering, provider
// replacement/withdraw facade stability, disposal-race and custom-transport
// race/sequence-gap timing tests.

import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../src/context.ts";
import { applyImmutable } from "../src/delta.ts";
import {
	type Context,
	createLoopbackServiceTransport,
	createRemoteServiceBinding,
	defineService,
	isRemoteServiceErrorCode,
	RemoteServiceError,
	type ReplicatedState,
	replicatedState,
} from "../src/index.ts";
import { RemoteServiceProvider } from "../src/services/provider.ts";

type ModelRef = { provider: string; modelId: string };
type ModelsState = {
	selected: ModelRef | null;
	revision: number;
};
interface Models {
	readonly state: ReplicatedState<ModelsState>;
	select(model: ModelRef, context: Context): Promise<void>;
}

const Models = defineService<Models>("test.models");

type Question = { question: string };
interface QuestionDialogs {
	readonly request: ReplicatedState<Question>;
	submit(answer: string, context: Context): Promise<{ accepted: boolean }>;
}

const QuestionDialogs = defineService<QuestionDialogs>("test.question-dialog");

type EchoPayload = { value: string };
interface Echo {
	echo(payload: EchoPayload, context: Context): Promise<EchoPayload>;
}

const Echo = defineService<Echo>("test.echo");

interface Timeline {
	readonly state: ReplicatedState<{ entries: { id: string }[]; retained: { value: number } }>;
}

const Timeline = defineService<Timeline>("test.timeline");

describe("remote services", () => {
	test("marks services remotable by default and reserves Chord service IDs", () => {
		const local = defineService<{ readonly value: string }>("test.local", { local: true });
		expect(Models.local).toBe(false);
		expect(local.local).toBe(true);
		expect(() => defineService("$chord.internal", { local: true })).toThrow(
			"Service IDs beginning with $chord. are reserved",
		);
		expect(() => new RemoteServiceProvider([local])).toThrow("cannot be published remotely");
	});

	test("tracks mutable source state while publishing immutable revisions", () => {
		const initial: ModelsState = { selected: null, revision: 0 };
		const state = replicatedState(initial);
		let delivered: ModelsState | undefined;
		const deliveries: string[] = [];
		const unsubscribe = state.subscribe((value, _context, delivery) => {
			delivered = value;
			deliveries.push(delivery.kind);
		});
		expect(state.value).toEqual(initial);
		expect(state.value).not.toBe(initial);
		expect(delivered).toBe(state.value);
		const hydrated = delivered;

		state.state.selected = { provider: "test", modelId: "one" };
		state.state.revision = 1;
		state.publish(BACKGROUND_CONTEXT);
		expect(state.value).toEqual({ selected: { provider: "test", modelId: "one" }, revision: 1 });
		expect(state.value).not.toBe(initial);
		expect(delivered).toBe(state.value);
		expect(hydrated).toEqual({ selected: null, revision: 0 });
		expect(deliveries).toEqual(["hydrate", "update"]);
		unsubscribe();
	});

	test("does not defensively clone method arguments or results", async () => {
		const provider = new RemoteServiceProvider([Echo]);
		let received: EchoPayload | undefined;
		const response: EchoPayload = { value: "response" };
		provider.provide(Echo, {
			async echo(payload) {
				received = payload;
				return response;
			},
		});
		const namespace = createRemoteServiceBinding({
			services: [Echo],
			transport: createLoopbackServiceTransport(provider),
		});
		const echo = namespace.use(Echo);
		await namespace.ready(BACKGROUND_CONTEXT);
		const request: EchoPayload = { value: "request" };

		await expect(echo.echo(request, BACKGROUND_CONTEXT)).resolves.toBe(response);
		expect(received).toBe(request);

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("provides and consumes one singleton with replicated state", async () => {
		const provider = new RemoteServiceProvider([Models]);
		expect(provider.catalogue).toEqual([{ serviceId: Models.id, mode: "singleton" }]);
		const initialState: ModelsState = { selected: null, revision: 0 };
		const state = replicatedState(initialState);
		let publishedState: ModelsState | undefined;
		provider.provide(Models, {
			state,
			async select(model, context) {
				state.state.selected = model;
				state.state.revision += 1;
				state.publish(context);
				publishedState = state.value;
			},
		});
		const errors: Error[] = [];
		const namespace = createRemoteServiceBinding({
			services: [Models],
			transport: createLoopbackServiceTransport(provider),
			onError: (error) => errors.push(error),
		});

		const first = namespace.use(Models);
		const second = namespace.use(Models);
		expect(first).toBe(second);
		expect(first.state.value).toBeUndefined();
		await namespace.ready(BACKGROUND_CONTEXT);
		expect(first.state.value).toEqual(initialState);

		const updates: ModelsState[] = [];
		const unsubscribe = second.state.subscribe((value) => updates.push(value));
		await first.select({ provider: "test", modelId: "one" }, BACKGROUND_CONTEXT);
		expect(first.state.value).toEqual(publishedState);
		expect(first.state.value).toEqual({
			selected: { provider: "test", modelId: "one" },
			revision: 1,
		});
		expect(updates).toEqual([
			{ selected: null, revision: 0 },
			{ selected: { provider: "test", modelId: "one" }, revision: 1 },
		]);
		expect(errors).toEqual([]);

		const lateNamespace = createRemoteServiceBinding({
			services: [Models],
			transport: createLoopbackServiceTransport(provider),
		});
		const lateModels = lateNamespace.use(Models);
		await lateNamespace.ready(BACKGROUND_CONTEXT);
		expect(lateModels.state.value?.revision).toBe(1);

		unsubscribe();
		await Promise.all([namespace.dispose(BACKGROUND_CONTEXT), lateNamespace.dispose(BACKGROUND_CONTEXT)]);
		provider.dispose();
	});

	test("publishes compact tracked operations through the remote provider", async () => {
		const provider = new RemoteServiceProvider([Timeline]);
		const initial = { entries: [{ id: "one" }], retained: { value: 1 } };
		const source = replicatedState(initial);
		provider.provide(Timeline, { state: source });
		const updates: Array<Parameters<Parameters<typeof provider.subscribe>[2]>[0]> = [];
		const raw = provider.subscribe(Timeline.id, "singleton", (update) => updates.push(update));
		expect(raw.snapshot.instances[0]?.members).toEqual([
			{ name: "state", kind: "state", sequence: 0, ops: [["r", initial]] },
		]);
		raw.activate();

		const namespace = createRemoteServiceBinding({
			services: [Timeline],
			transport: createLoopbackServiceTransport(provider),
		});
		const timeline = namespace.use(Timeline);
		await namespace.ready(BACKGROUND_CONTEXT);
		const previous = timeline.state.value;
		const next = { entries: [{ id: "one" }, { id: "two" }], retained: initial.retained };
		source.state.entries.push({ id: "two" });
		source.publish(BACKGROUND_CONTEXT);

		const update = updates.find((candidate) => candidate.type === "state")!;
		expect(update).toMatchObject({ type: "state", member: "state", sequence: 1 });
		// The received ops transform the previously published value into the new one.
		const applied = update.type === "state" ? applyImmutable(structuredClone(previous), update.ops) : undefined;
		expect(applied).toEqual(next);
		expect(previous).toEqual({ entries: [{ id: "one" }], retained: { value: 1 } });
		expect(timeline.state.value).toEqual(next);

		source.state.entries.push({ id: "three" });
		source.publish(BACKGROUND_CONTEXT);
		const late = provider.subscribe(Timeline.id, "singleton", () => {});
		expect(late.snapshot.instances[0]?.members).toEqual([
			{
				name: "state",
				kind: "state",
				sequence: 2,
				ops: [["r", { entries: [{ id: "one" }, { id: "two" }, { id: "three" }], retained: { value: 1 } }]],
			},
		]);
		late.close();
		raw.close();
		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("propagates method failures and provider-level RemoteServiceErrors", async () => {
		const provider = new RemoteServiceProvider([Echo]);
		provider.provide(Echo, {
			async echo() {
				throw new Error("echo failed");
			},
		});
		const namespace = createRemoteServiceBinding({
			services: [Echo],
			transport: createLoopbackServiceTransport(provider),
		});
		const echo = namespace.use(Echo);
		await namespace.ready(BACKGROUND_CONTEXT);
		await expect(echo.echo({ value: "request" }, BACKGROUND_CONTEXT)).rejects.toThrow("echo failed");
		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();

		const unprovided = new RemoteServiceProvider([Echo]);
		const unprovidedNamespace = createRemoteServiceBinding({
			services: [Echo],
			transport: createLoopbackServiceTransport(unprovided),
		});
		unprovidedNamespace.use(Echo);
		let failure: unknown;
		try {
			await unprovidedNamespace.ready(BACKGROUND_CONTEXT);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(RemoteServiceError);
		expect((failure as RemoteServiceError).code).toBe("service_not_found");
		expect(isRemoteServiceErrorCode((failure as RemoteServiceError).code)).toBe(true);
		await unprovidedNamespace.dispose(BACKGROUND_CONTEXT);
		unprovided.dispose();
	});

	test("hydrates keyed state before observe handlers and fences reused keys", async () => {
		const provider = new RemoteServiceProvider([{ service: QuestionDialogs, mode: "keyed" }]);
		expect(provider.catalogue).toEqual([{ serviceId: QuestionDialogs.id, mode: "keyed" }]);
		const transport = createLoopbackServiceTransport(provider);
		const errors: Error[] = [];
		const namespace = createRemoteServiceBinding({
			services: [QuestionDialogs],
			transport,
			onError: (error) => errors.push(error),
		});
		const observed: {
			question: Question | undefined;
			service: QuestionDialogs;
			context: Context;
		}[] = [];
		const stop = namespace.observe(QuestionDialogs, (service, context) => {
			observed.push({
				question: service.request.value,
				service,
				context,
			});
		});
		await vi.waitFor(() => expect(errors).toEqual([]));

		const firstRequest = replicatedState<Question>({ question: "First?" });
		const firstSubmit = vi.fn(async () => ({ accepted: true }));
		const closeFirst = provider.spawn(QuestionDialogs, "invocation-1", {
			request: firstRequest,
			submit: firstSubmit,
		});
		await vi.waitFor(() => expect(observed).toHaveLength(1));
		expect(observed[0]).toMatchObject({ question: { question: "First?" } });

		const firstService = observed[0]!.service;
		firstRequest.state.question = "Updated?";
		firstRequest.publish(BACKGROUND_CONTEXT);
		expect(firstService.request.value).toEqual({ question: "Updated?" });
		await expect(firstService.submit("yes", BACKGROUND_CONTEXT)).resolves.toEqual({ accepted: true });
		expect(firstSubmit).toHaveBeenCalledWith("yes", expect.objectContaining({ abortSignal: undefined }));

		const retainedFirstSubmit = firstService.submit;
		closeFirst();
		expect(observed[0]!.context.abortSignal?.aborted).toBe(true);
		expect(() => firstService.request.value).toThrow("observation is closed");
		expect(() => retainedFirstSubmit("late", BACKGROUND_CONTEXT)).toThrow("observation is closed");

		const secondRequest = replicatedState<Question>({ question: "Again?" });
		const closeSecond = provider.spawn(QuestionDialogs, "invocation-1", {
			request: secondRequest,
			async submit() {
				return { accepted: false };
			},
		});
		await vi.waitFor(() => expect(observed).toHaveLength(2));
		expect(observed[1]).toMatchObject({ question: { question: "Again?" } });
		expect(Object.is(observed[1]!.service, firstService)).toBe(false);
		expect(errors).toEqual([]);

		const secondService = observed[1]!.service;
		const retainedSecondSubmit = secondService.submit;
		stop();
		expect(observed[1]!.context.abortSignal?.aborted).toBe(true);
		expect(() => secondService.request.value).toThrow("observation is closed");
		expect(() => retainedSecondSubmit("late", BACKGROUND_CONTEXT)).toThrow("observation is closed");
		closeSecond();
		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});

	test("hydrates cold ReplicatedState replicas and replaces them across rebinds", async () => {
		const provider = new RemoteServiceProvider([Models]);
		const state = replicatedState<ModelsState>({ selected: null, revision: 0 });
		provider.provide(Models, {
			state,
			async select() {},
		});
		const namespace = createRemoteServiceBinding({
			services: [Models],
			transport: createLoopbackServiceTransport(provider),
			bound: false,
		});
		const models = namespace.use(Models);
		const revisions: number[] = [];
		models.state.subscribe((value) => revisions.push(value.revision));
		expect(models.state.value).toBeUndefined();
		expect(revisions).toEqual([]);

		state.state.revision = 1;
		state.publish(BACKGROUND_CONTEXT);
		await namespace.rebind(true, BACKGROUND_CONTEXT);
		expect(models.state.value?.revision).toBe(1);
		expect(revisions).toEqual([1]);
		state.state.revision = 2;
		state.publish(BACKGROUND_CONTEXT);
		expect(revisions).toEqual([1, 2]);

		await namespace.rebind(false, BACKGROUND_CONTEXT);
		expect(models.state.value).toBeUndefined();
		state.state.revision = 3;
		state.publish(BACKGROUND_CONTEXT);
		expect(revisions).toEqual([1, 2]);
		await namespace.rebind(true, BACKGROUND_CONTEXT);
		expect(models.state.value?.revision).toBe(3);
		expect(revisions).toEqual([1, 2, 3]);

		await namespace.dispose(BACKGROUND_CONTEXT);
		provider.dispose();
	});
});
