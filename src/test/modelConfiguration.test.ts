import * as assert from "assert";
import * as vscode from "vscode";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { GeminiApi } from "../gemini/geminiApi";
import {
	createReasoningEffortConfigurationSchema,
	getConfiguredReasoningEffort,
	isReasoningEffortPickerEnabled,
	type ModelPickerChatInformation,
	REASONING_EFFORT_CONFIGURATION_SCHEMA,
} from "../modelConfiguration";
import { OllamaApi } from "../ollama/ollamaApi";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { prepareLanguageModelChatInformation } from "../provideModel";
import type { HFModelItem } from "../types";

suite("modelConfiguration", () => {
	const deepSeekModel: HFModelItem = {
		id: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		owned_by: "deepseek",
		baseUrl: "https://api.deepseek.com",
		apiMode: "openai",
		context_length: 1_000_000,
		max_tokens: 384_000,
		reasoning_effort: "medium",
	};

	test("only enables the picker when the model has a reasoning effort default", () => {
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "custom" }), false);
		assert.strictEqual(isReasoningEffortPickerEnabled({ id: "m", owned_by: "p", reasoning_effort: "high" }), true);
	});

	test("defines reasoning effort choices for provider configuration", () => {
		const schema = REASONING_EFFORT_CONFIGURATION_SCHEMA.properties.reasoningEffort;
		assert.strictEqual(schema.title, "Reasoning Effort");
		assert.strictEqual(schema.default, "medium");
		assert.deepStrictEqual(schema.enum, ["minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.strictEqual(createReasoningEffortConfigurationSchema("high").properties.reasoningEffort.default, "high");
	});

	test("reads the selected reasoning effort from VS Code model configuration", () => {
		assert.strictEqual(getConfiguredReasoningEffort(undefined), "medium");
		assert.strictEqual(getConfiguredReasoningEffort(undefined, "low"), "low");
		assert.strictEqual(
			getConfiguredReasoningEffort({ modelConfiguration: { reasoningEffort: "high" } } as never),
			"high"
		);
		assert.strictEqual(getConfiguredReasoningEffort({ configuration: { reasoningEffort: "max" } } as never), "max");
		assert.strictEqual(
			getConfiguredReasoningEffort({ modelConfiguration: { reasoningEffort: "invalid" } } as never, "xhigh"),
			"xhigh"
		);
	});

	test("registers deepseek-v4-flash with reasoning effort metadata", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = { ...deepSeekModel, id: "deepseek-v4-flash", displayName: undefined };

		try {
			await config.update("oaicopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, {} as vscode.SecretStorage);
			const info = infos.find((item) => item.id === "deepseek-v4-flash") as ModelPickerChatInformation | undefined;

			assert.ok(info, "deepseek-v4-flash should be registered");
			assert.strictEqual(info.name, "deepseek-v4-flash");
			assert.strictEqual(info.detail, "deepseek (OAICopilot)");
			assert.strictEqual(info.isUserSelectable, true);
			assert.deepStrictEqual(info.configurationSchema, createReasoningEffortConfigurationSchema("medium"));
		} finally {
			cts.dispose();
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("does not register reasoning effort metadata when the default is empty", async () => {
		const config = vscode.workspace.getConfiguration();
		const previousModels = config.get<unknown>("oaicopilot.models", []);
		const cts = new vscode.CancellationTokenSource();
		const model: HFModelItem = {
			...deepSeekModel,
			id: "deepseek-v4-flash",
			displayName: undefined,
			reasoning_effort: undefined,
		};

		try {
			await config.update("oaicopilot.models", [model], vscode.ConfigurationTarget.Global);

			const infos = await prepareLanguageModelChatInformation({ silent: true }, cts.token, {} as vscode.SecretStorage);
			const info = infos.find((item) => item.id === "deepseek-v4-flash") as ModelPickerChatInformation | undefined;

			assert.ok(info, "deepseek-v4-flash should be registered");
			assert.strictEqual(info.configurationSchema, undefined);
		} finally {
			cts.dispose();
			await config.update("oaicopilot.models", previousModels, vscode.ConfigurationTarget.Global);
		}
	});

	test("applies selected reasoning effort to OpenAI-compatible chat requests", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			deepSeekModel,
			{ modelConfiguration: { reasoningEffort: "high" } } as never
		);

		assert.strictEqual(requestBody.reasoning_effort, "high");
	});

	test("falls back to the configured default reasoning effort when Copilot has no temporary override", () => {
		const requestBody = new OpenaiApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", messages: [], stream: true },
			{ ...deepSeekModel, reasoning_effort: "low" },
			undefined
		);

		assert.strictEqual(requestBody.reasoning_effort, "low");
	});

	test("applies selected reasoning effort to OpenAI Responses requests", () => {
		const requestBody = new OpenaiResponsesApi("deepseek-v4-pro").prepareRequestBody(
			{ model: "deepseek-v4-pro", input: [], stream: true },
			{ ...deepSeekModel, apiMode: "openai-responses" },
			{ modelConfiguration: { reasoningEffort: "max" } } as never
		);

		assert.deepStrictEqual(requestBody.reasoning, { effort: "max" });
	});

	test("streams OpenAI Responses text from completed events with top-level output", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							type: "response.completed",
							id: "resp_1",
							output: [
								{
									type: "message",
									content: [{ type: "output_text", text: "hello from completed" }],
								},
							],
						})}\n\n`
					)
				);
				controller.close();
			},
		});
		const parts: vscode.LanguageModelResponsePart2[] = [];

		await new OpenaiResponsesApi("gpt-5").processStreamingResponse(
			stream,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token
		);

		const textParts = parts.filter((part): part is vscode.LanguageModelTextPart =>
			part instanceof vscode.LanguageModelTextPart
		);
		assert.strictEqual(textParts.map((part) => part.value).join(""), "hello from completed");
	});

	test("streams OpenAI Responses text from completed events with nested response output", async () => {
		const expectedText = "The sum of 2 and 2 is calculated as follows:\n\n$$2 + 2 = 4$$\n\n**Answer:** 4";
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							response: {
								id: "resp_93c5e7dd8f587d45",
								created_at: 1783491187,
								model: "qwen3.6-27b",
								object: "response",
								output: [
									{
										id: "msg_805c4709e9eb85c5",
										content: [
											{
												annotations: [],
												text: expectedText,
												type: "output_text",
												logprobs: null,
											},
										],
										role: "assistant",
										status: "completed",
										type: "message",
									},
								],
								status: "completed",
								usage: {
									input_tokens: 16,
									output_tokens: 30,
									total_tokens: 46,
								},
							},
							sequence_number: 16,
							type: "response.completed",
						})}\n\n`
					)
				);
				controller.close();
			},
		});
		const parts: vscode.LanguageModelResponsePart2[] = [];

		await new OpenaiResponsesApi("qwen3.6-27b").processStreamingResponse(
			stream,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token
		);

		const textParts = parts.filter((part): part is vscode.LanguageModelTextPart =>
			part instanceof vscode.LanguageModelTextPart
		);
		assert.strictEqual(textParts.map((part) => part.value).join(""), expectedText);
	});

	test("streams OpenAI Responses text from multi-line SSE data payloads", async () => {
		const expectedText = "multi-line SSE payload works";
		const payload = JSON.stringify({
			response: {
				id: "resp_multiline",
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: expectedText }],
					},
				],
			},
			type: "response.completed",
		});
		const midpoint = Math.floor(payload.length / 2);
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(`data: ${payload.slice(0, midpoint)}\n`));
				controller.enqueue(encoder.encode(`data: ${payload.slice(midpoint)}\n\n`));
				controller.close();
			},
		});
		const parts: vscode.LanguageModelResponsePart2[] = [];

		await new OpenaiResponsesApi("qwen3.6-27b").processStreamingResponse(
			stream,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token
		);

		const textParts = parts.filter((part): part is vscode.LanguageModelTextPart =>
			part instanceof vscode.LanguageModelTextPart
		);
		assert.strictEqual(textParts.map((part) => part.value).join(""), expectedText);
	});

	test("does not fail OpenAI Responses streams that only emit function calls", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							type: "response.output_item.done",
							output_index: 0,
							item: {
								type: "function_call",
								call_id: "call_1",
								name: "read_file",
								arguments: JSON.stringify({ filePath: "a.ts", startLine: 1, endLine: 2 }),
							},
						})}\n\n`
					)
				);
				controller.close();
			},
		});
		const parts: vscode.LanguageModelResponsePart2[] = [];

		await new OpenaiResponsesApi("gpt-5").processStreamingResponse(
			stream,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token
		);

		const toolParts = parts.filter((part): part is vscode.LanguageModelToolCallPart =>
			part instanceof vscode.LanguageModelToolCallPart
		);
		assert.strictEqual(toolParts.length, 1);
		assert.strictEqual(toolParts[0].name, "read_file");
	});

	test("does not fail OpenAI Responses streams that complete with empty output", async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							response: {
								id: "resp_empty_completed",
								model: "qwen3.6-27b",
								object: "response",
								output: [],
								status: "completed",
								usage: {
									input_tokens: 999,
									output_tokens: 1,
									total_tokens: 1000,
								},
							},
							sequence_number: 3,
							type: "response.completed",
						})}\n\n`
					)
				);
				controller.close();
			},
		});
		const parts: vscode.LanguageModelResponsePart2[] = [];

		await new OpenaiResponsesApi("qwen3.6-27b").processStreamingResponse(
			stream,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token
		);

		const textParts = parts.filter((part): part is vscode.LanguageModelTextPart =>
			part instanceof vscode.LanguageModelTextPart
		);
		// When the stream completes with empty output, we should emit a fallback text part
		// so that the VS Code/Copilot host doesn't show "Sorry, no response was returned."
		assert.strictEqual(textParts.length, 1);
		assert.ok(textParts[0].value.includes("model"), "fallback text should mention the model");
	});

	test("does not duplicate OpenAI Responses final snapshots after text deltas", async () => {
		const expectedText = "The sum of 2 and 2 is calculated as follows:\n\n$$2 + 2 = 4$$\n\n**Answer:** 4";
		const events = [
			{
				type: "response.created",
				response: { id: "resp_93c5e7dd8f587d45", output: [], status: "in_progress" },
			},
			{
				type: "response.in_progress",
				response: { id: "resp_93c5e7dd8f587d45", output: [], status: "in_progress" },
			},
			{
				type: "response.output_item.added",
				item: { id: "bf39654932d56f5a", content: [], role: "assistant", status: "in_progress", type: "message" },
				output_index: 0,
			},
			{
				type: "response.content_part.added",
				part: { annotations: [], text: "", type: "output_text", logprobs: [] },
				content_index: 0,
				item_id: "bf39654932d56f5a",
				output_index: 0,
			},
			...[
				"The",
				" sum",
				" of 2 and",
				" 2 is calculated",
				" as follows:\n\n",
				"$$2 + ",
				"2 = 4",
				"$$\n\n**Answer",
				":** 4",
			].map((delta, index) => ({
				type: "response.output_text.delta",
				content_index: 0,
				delta,
				item_id: "bf39654932d56f5a",
				output_index: 0,
				sequence_number: index + 4,
			})),
			{
				type: "response.output_text.done",
				content_index: 0,
				item_id: "bf39654932d56f5a",
				output_index: 0,
				text: expectedText,
			},
			{
				type: "response.content_part.done",
				content_index: 0,
				item_id: "bf39654932d56f5a",
				output_index: 0,
				part: { annotations: [], text: expectedText, type: "output_text", logprobs: null },
			},
			{
				type: "response.output_item.done",
				item: {
					id: "bf39654932d56f5a",
					content: [{ annotations: [], text: expectedText, type: "output_text", logprobs: null }],
					role: "assistant",
					status: "completed",
					type: "message",
				},
				output_index: 0,
			},
			{
				type: "response.completed",
				response: {
					id: "resp_93c5e7dd8f587d45",
					output: [
						{
							id: "msg_805c4709e9eb85c5",
							content: [{ annotations: [], text: expectedText, type: "output_text", logprobs: null }],
							role: "assistant",
							status: "completed",
							type: "message",
						},
					],
					status: "completed",
					usage: { input_tokens: 16, output_tokens: 30, total_tokens: 46 },
				},
			},
		];
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
				}
				controller.close();
			},
		});
		const parts: vscode.LanguageModelResponsePart2[] = [];

		await new OpenaiResponsesApi("qwen3.6-27b").processStreamingResponse(
			stream,
			{ report: (part) => parts.push(part) },
			new vscode.CancellationTokenSource().token
		);

		const textParts = parts.filter((part): part is vscode.LanguageModelTextPart =>
			part instanceof vscode.LanguageModelTextPart
		);
		assert.strictEqual(textParts.map((part) => part.value).join(""), expectedText);
	});

	test("keeps the picker out of unsupported native API request bodies", () => {
		const options = { modelConfiguration: { reasoningEffort: "high" } } as never;
		const anthropicBody = new AnthropicApi("claude").prepareRequestBody(
			{ model: "claude", messages: [], max_tokens: 1024, stream: true },
			{ ...deepSeekModel, apiMode: "anthropic" },
			options
		) as unknown as Record<string, unknown>;
		const ollamaBody = new OllamaApi("qwen3").prepareRequestBody(
			{ model: "qwen3", messages: [], stream: true },
			{ ...deepSeekModel, apiMode: "ollama" },
			options
		) as unknown as Record<string, unknown>;
		const geminiBody = new GeminiApi("gemini").prepareRequestBody(
			{ contents: [] },
			{ ...deepSeekModel, apiMode: "gemini" },
			options
		) as Record<string, unknown>;

		assert.strictEqual(anthropicBody.reasoning_effort, undefined);
		assert.strictEqual(anthropicBody.thinking, undefined);
		assert.strictEqual(ollamaBody.reasoning_effort, undefined);
		assert.strictEqual(ollamaBody.think, undefined);
		assert.strictEqual(geminiBody.reasoning_effort, undefined);
		assert.strictEqual(geminiBody.thinkingConfig, undefined);
	});
});
