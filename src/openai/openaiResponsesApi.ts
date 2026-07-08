import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	ProvideLanguageModelChatResponseOptions,
	LanguageModelResponsePart2,
	Progress,
} from "vscode";

import type { HFModelItem } from "../types";
import { getConfiguredReasoningEffort, isReasoningEffortPickerEnabled } from "../modelConfiguration";
import type { OpenAIToolCall } from "./openaiTypes";

import {
	isImageMimeType,
	createDataUrl,
	isToolResultPart,
	collectToolResultText,
	convertToolsToOpenAIResponses,
	mapRole,
} from "../utils";

import { CommonApi } from "../commonApi";
import { logger } from "../logger";

export interface ResponsesInputMessage {
	role: "user" | "assistant" | "system";
	content: ResponsesContentPart[];
	type?: "message";
	id?: string;
	status?: "completed" | "incomplete";
}

export interface ResponsesContentPart {
	type: "input_text" | "input_image" | "output_text" | "summary_text";
	text?: string;
	image_url?: string;
	detail?: "auto";
}

export interface ResponsesFunctionCall {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	arguments: string;
	status: "completed";
}

export interface ResponsesFunctionCallOutput {
	type: "function_call_output";
	call_id: string;
	output: string;
	id: string;
	status: "completed";
}

export interface ResponsesReasoning {
	type: "reasoning";
	summary: ResponsesContentPart[];
	id: string;
	status: "completed";
}

export type ResponsesInputItem =
	| ResponsesInputMessage
	| ResponsesFunctionCall
	| ResponsesFunctionCallOutput
	| ResponsesReasoning;

export class OpenaiResponsesApi extends CommonApi<ResponsesInputItem, Record<string, unknown>> {
	private _responseId: string | null = null;
	private _emittedResponsesOutputText = false;
	private _emittedResponsesToolCall = false;
	private _sawResponsesTerminalEvent = false;
	private _responsesDeltaOutputIndices = new Set<number>();
	private _responsesSseDataLines: string[] = [];

	constructor(modelId: string) {
		super(modelId);
	}

	get responseId(): string | null {
		return this._responseId;
	}

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ResponsesInputItem[] {
		const out: ResponsesInputItem[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: OpenAIToolCall[] = [];
			const toolResults: { callId: string; content: string }[] = [];
			const thinkingParts: string[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					let args = "{}";
					try {
						args = JSON.stringify(part.input ?? {});
					} catch {
						args = "{}";
					}
					toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({ callId, content });
				} else if (part instanceof vscode.LanguageModelThinkingPart && modelConfig.includeReasoningInRequest) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingParts.push(content);
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = thinkingParts.join("").trim();

			// assistant message (optional)
			if (role === "assistant") {
				if (joinedText) {
					out.push({
						role: "assistant",
						content: [{ type: "output_text", text: joinedText }],
						type: "message",
						id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						status: "completed",
					});
				}

				if (joinedThinking) {
					out.push({
						summary: [{ type: "summary_text", text: joinedThinking }],
						type: "reasoning",
						id: `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						status: "completed",
					});
				}

				for (const tc of toolCalls) {
					out.push({
						type: "function_call",
						id: `fc_${tc.id}`,
						call_id: tc.id,
						name: tc.function.name,
						arguments: tc.function.arguments,
						status: "completed",
					});
				}
			}

			// tool outputs
			for (const tr of toolResults) {
				if (!tr.callId) {
					continue;
				}
				out.push({
					type: "function_call_output",
					call_id: tr.callId,
					output: tr.content || "",
					id: `fco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					status: "completed",
				});
			}

			// user message
			if (role === "user") {
				const contentArray: ResponsesContentPart[] = [];
				if (joinedText) {
					contentArray.push({ type: "input_text", text: joinedText });
				}
				for (const imagePart of imageParts) {
					const dataUrl = createDataUrl(imagePart);
					contentArray.push({ type: "input_image", image_url: dataUrl, detail: "auto" });
				}
				if (contentArray.length > 0) {
					out.push({
						role: "user",
						content: contentArray,
						type: "message",
						status: "completed",
					});
				}
			}

			// system message (used to build `instructions` in request body)
			if (role === "system" && joinedText) {
				this._systemContent = joinedText;
			}
		}

		// Note: The last user message is typically the most recent one in a conversation.
		// Some OpenAI-compatible gateways (e.g., new-api.ai) may return empty output
		// when they see status: "incomplete" on the last message. We keep it as "completed"
		// to improve compatibility with these gateways.
		return out;
	}

	prepareRequestBody(
		rb: Record<string, unknown>,
		um: HFModelItem | undefined,
		options?: ProvideLanguageModelChatResponseOptions
	): Record<string, unknown> {
		const isPlainObject = (v: unknown): v is Record<string, unknown> =>
			!!v && typeof v === "object" && !Array.isArray(v);

		// Add system content if we extracted it
		if (this._systemContent) {
			rb.instructions = this._systemContent;
		}

		// temperature
		if (um?.temperature !== undefined && um.temperature !== null) {
			rb.temperature = um.temperature;
		}

		// top_p
		if (um?.top_p !== undefined && um.top_p !== null) {
			rb.top_p = um.top_p;
		}

		// max_output_tokens
		if (um?.max_completion_tokens !== undefined) {
			rb.max_output_tokens = um.max_completion_tokens;
		} else if (um?.max_tokens !== undefined) {
			rb.max_output_tokens = um.max_tokens;
		}

		// OpenAI reasoning configuration
		if (isReasoningEffortPickerEnabled(um)) {
			const existing = isPlainObject(rb.reasoning) ? { ...(rb.reasoning as Record<string, unknown>) } : {};
			rb.reasoning = {
				...existing,
				effort: getConfiguredReasoningEffort(options, um.reasoning_effort),
			};
		} else if (um?.reasoning_effort !== undefined) {
			const existing = isPlainObject(rb.reasoning) ? { ...(rb.reasoning as Record<string, unknown>) } : {};
			rb.reasoning = {
				...existing,
				effort: um.reasoning_effort,
			};
		}

		// thinking (Volcengine provider)
		if (um?.thinking?.type !== undefined) {
			rb.thinking = {
				type: um.thinking.type,
			};
		}

		// stop
		if (options?.modelOptions) {
			const mo = options.modelOptions as Record<string, unknown>;
			if (typeof mo.stop === "string" || Array.isArray(mo.stop)) {
				rb.stop = mo.stop;
			}
		}

		// tools
		const toolConfig = convertToolsToOpenAIResponses(options);
		if (toolConfig.tools) {
			rb.tools = toolConfig.tools;
		}
		if (toolConfig.tool_choice) {
			rb.tool_choice = toolConfig.tool_choice;
		}

		// Process extra configuration parameters
		if (um?.extra && typeof um.extra === "object") {
			for (const [key, value] of Object.entries(um.extra)) {
				if (value !== undefined) {
					// Deep-merge reasoning config so `extra.reasoning` doesn't clobber `reasoning.effort`.
					if (key === "reasoning" && isPlainObject(value) && isPlainObject(rb.reasoning)) {
						rb.reasoning = { ...(rb.reasoning as Record<string, unknown>), ...(value as Record<string, unknown>) };
						continue;
					}
					if (key === "tools" && Array.isArray(value) && Array.isArray(rb.tools)) {
						rb.tools = [...rb.tools, ...value];
					} else {
						rb[key] = value;
					}
				}
			}
		}

		return rb;
	}

	async processStreamingResponse(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		this._responseId = null;
		this._emittedResponsesOutputText = false;
		this._emittedResponsesToolCall = false;
		this._sawResponsesTerminalEvent = false;
		this._responsesDeltaOutputIndices = new Set<number>();
		this._responsesSseDataLines = [];
		const modelId = this._modelId;
		logger.debug("responses.stream.start", { modelId });
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEventType = "";

		try {
			while (true) {
				if (token.isCancellationRequested) {
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					currentEventType = await this.processResponsesSseLine(line, currentEventType, progress);
				}
			}

			buffer += decoder.decode();
			if (buffer.trim()) {
				currentEventType = await this.processResponsesSseLine(buffer, currentEventType, progress);
			}
			await this.flushResponsesSseEvent(currentEventType, progress);
			if (!this._emittedResponsesOutputText && !this._emittedResponsesToolCall && !this._sawResponsesTerminalEvent) {
				throw new Error("Responses API returned no text output.");
			}
			// If the stream completed legally but without any visible output (text, tool call, or thinking),
			// emit a fallback text part so the VS Code/Copilot host doesn't show "Sorry, no response was returned."
			if (!this._hasEmittedAssistantText && !this._hasEmittedThinking && this._completedToolCallIndices.size === 0) {
				progress.report(new vscode.LanguageModelTextPart("The model completed without returning any content."));
			}
			logger.debug("responses.stream.done", { modelId, responseId: this._responseId ?? "" });
		} catch (e) {
			console.error("[OpenAI-Responses Provider] Streaming response error:", e);
			logger.error("responses.stream.error", { modelId, error: e instanceof Error ? e.message : String(e) });
			throw e;
		} finally {
			reader.releaseLock();
			this.reportEndThinking(progress);
			// Report accumulated usage for the Context Window widget
			this.reportUsage(progress);
		}
	}

	private coerceText(value: unknown): string {
		if (typeof value === "string") {
			return value;
		}
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			if (typeof obj.text === "string") {
				return obj.text;
			}
			if (typeof obj.thinking === "string") {
				return obj.thinking;
			}
			if (typeof obj.reasoning === "string") {
				return obj.reasoning;
			}
			if (typeof obj.summary === "string") {
				return obj.summary;
			}
			if (typeof obj.value === "string") {
				return obj.value;
			}
		}
		return "";
	}

	private looksLikeReasoningConfigValue(value: string): boolean {
		const v = (value || "").trim().toLowerCase();
		return (
			v === "high" ||
			v === "medium" ||
			v === "low" ||
			v === "minimal" ||
			v === "auto" ||
			v === "none" ||
			v === "detailed" ||
			v === "concise"
		);
	}

	private processOutputTextChunk(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		if (!text) {
			return;
		}
		// Process XML think blocks or text content (mutually exclusive)
		const xmlRes = this.processXmlThinkBlocks(text, progress);
		if (!xmlRes.emittedAny) {
			// If there's an active thinking sequence, end it first
			this.reportEndThinking(progress);

			// Only process text content if no XML think blocks were emitted
			const res = this.processTextContent(text, progress);
			if (res.emittedAny) {
				this._hasEmittedAssistantText = true;
				this._hasEmittedText = true;
				this._emittedResponsesOutputText = true;
			}
		}
	}

	private async processResponsesSseLine(
		line: string,
		currentEventType: string,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<string> {
		const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
		const trimmedLine = normalizedLine.trim();
		if (!trimmedLine) {
			await this.flushResponsesSseEvent(currentEventType, progress);
			return "";
		}

		if (trimmedLine.startsWith(":")) {
			return currentEventType;
		}

		if (trimmedLine.startsWith("event:")) {
			return trimmedLine.slice(6).trim();
		}

		if (!trimmedLine.startsWith("data:")) {
			return currentEventType;
		}

		let dataLine = normalizedLine.slice(normalizedLine.indexOf(":") + 1);
		if (dataLine.startsWith(" ")) {
			dataLine = dataLine.slice(1);
		}
		this._responsesSseDataLines.push(dataLine);
		return currentEventType;
	}

	private async flushResponsesSseEvent(
		currentEventType: string,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		if (this._responsesSseDataLines.length === 0) {
			return;
		}

		const data = this._responsesSseDataLines.join("\n").trim();
		const compactData = this._responsesSseDataLines.join("").trim();
		this._responsesSseDataLines = [];
		logger.debug("responses.stream.chunk", { modelId: this._modelId, data });
		if (!data || data === "[DONE]") {
			await this.flushToolCallBuffers(progress, false);
			return;
		}

		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(data) as Record<string, unknown>;
		} catch (e) {
			if (compactData === data) {
				throw e;
			}
			payload = JSON.parse(compactData) as Record<string, unknown>;
		}
		const type = typeof payload.type === "string" ? payload.type : currentEventType;
		await this.processStandardResponsesEvent(type, payload, progress);
	}

	private async processStandardResponsesEvent(
		eventType: string,
		event: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		this.captureResponseIdFromEvent(event);

		if (!eventType) {
			this.processOutputTextChunk(this.extractOutputTextFromEvent(event), progress);
			await this.processResponseToolEvent(event, progress);
			return;
		}

		switch (eventType) {
			case "error": {
				throw new Error(`Responses API streaming error: ${JSON.stringify(event)}`);
			}
			case "response.output_text.delta": {
				this.markResponsesDeltaOutputIndex(event);
				this.processOutputTextChunk(this.coerceText(event.delta), progress);
				return;
			}
			case "response.output_text.done": {
				if (!this.hasResponsesDeltaForEvent(event)) {
					this.processOutputTextChunk(this.coerceText(event.text), progress);
				}
				return;
			}
			case "response.content_part.added":
			case "response.content_part.done":
			case "response.output_item.added":
			case "response.output_item.done": {
				if (!this.hasResponsesDeltaForEvent(event)) {
					this.processOutputTextChunk(this.extractOutputTextFromEvent(event), progress);
				}
				await this.processResponseToolEvent(event, progress);
				return;
			}
			case "response.function_call_arguments.delta":
			case "response.function_call_arguments.done": {
				await this.processResponseToolEvent(event, progress);
				return;
			}
			case "response.completed":
			case "response.done": {
				this._sawResponsesTerminalEvent = true;
				if (!this._emittedResponsesOutputText) {
					this.processOutputTextChunk(
						this.extractOutputTextFromResponse(event.response) || this.extractOutputTextFromEvent(event),
						progress
					);
				}
				await this.processResponseToolEvent(event, progress);
				await this.flushToolCallBuffers(progress, false);
				this.reportEndThinking(progress);
				this.captureUsageFromResponse(event.response ?? event);
				return;
			}
			default: {
				this.processReasoningText(event, progress);
				this.processOutputTextChunk(this.extractOutputTextFromEvent(event), progress);
				await this.processResponseToolEvent(event, progress);
			}
		}
	}

	private markResponsesDeltaOutputIndex(event: Record<string, unknown>): void {
		const outputIndex = typeof event.output_index === "number" ? event.output_index : 0;
		this._responsesDeltaOutputIndices.add(outputIndex);
	}

	private hasResponsesDeltaForEvent(event: Record<string, unknown>): boolean {
		const outputIndex = typeof event.output_index === "number" ? event.output_index : 0;
		return this._responsesDeltaOutputIndices.has(outputIndex);
	}

	private extractOutputTextFromEvent(event: Record<string, unknown>): string {
		const directText = this.coerceText(event.delta ?? event.text ?? event.output_text ?? event.content);
		if (directText) {
			return directText;
		}

		const partText = this.extractOutputTextFromItem(event.part);
		if (partText) {
			return partText;
		}

		const itemText = this.extractOutputTextFromItem(event.item);
		if (itemText) {
			return itemText;
		}

		return this.extractOutputTextFromResponse(event.response ?? event);
	}

	private extractOutputTextFromItem(item: unknown): string {
		if (!item || typeof item !== "object") {
			return "";
		}

		const obj = item as Record<string, unknown>;
		const directText = this.coerceText(obj.text ?? obj.output_text ?? obj.refusal);
		if (directText) {
			return directText;
		}

		const content = obj.content;
		if (!Array.isArray(content)) {
			return "";
		}

		const chunks: string[] = [];
		for (const part of content) {
			if (!part || typeof part !== "object") {
				continue;
			}
			const contentPart = part as Record<string, unknown>;
			const type = typeof contentPart.type === "string" ? contentPart.type : "";
			if (
				type === "output_text" ||
				type === "refusal" ||
				type === "text" ||
				type === "message.output_text"
			) {
				const text = this.coerceText(contentPart.text ?? contentPart.content);
				if (text) {
					chunks.push(text);
				}
			}
		}
		return chunks.join("");
	}

	private extractOutputTextFromResponse(response: unknown): string {
		if (!response || typeof response !== "object") {
			return "";
		}

		const obj = response as Record<string, unknown>;
		const directText = this.coerceText(obj.output_text ?? obj.text);
		if (directText) {
			return directText;
		}

		const output = obj.output;
		if (!Array.isArray(output)) {
			return "";
		}

		return output.map((item) => this.extractOutputTextFromItem(item)).filter(Boolean).join("");
	}

	private captureUsageFromResponse(response: unknown): void {
		if (!response || typeof response !== "object") {
			return;
		}
		const usage = (response as Record<string, unknown>).usage;
		if (!usage || typeof usage !== "object") {
			return;
		}

		const u = usage as Record<string, unknown>;
		this._usage = {
			prompt_tokens: Number(u.input_tokens ?? 0),
			completion_tokens: Number(u.output_tokens ?? 0),
			total_tokens: Number(u.total_tokens ?? 0),
			prompt_tokens_details: u.input_tokens_details
				? { cached_tokens: Number((u.input_tokens_details as Record<string, unknown>).cached_tokens ?? 0) }
				: undefined,
		};
		logger.debug("usage.capture", { modelId: this._modelId, usage: this._usage });
	}

	private captureResponseIdFromEvent(event: Record<string, unknown>): void {
		if (this._responseId) {
			return;
		}

		const responseId = event.response_id;
		if (typeof responseId === "string" && responseId.trim()) {
			this._responseId = responseId;
			return;
		}

		const response = event.response;
		if (response && typeof response === "object" && !Array.isArray(response)) {
			const id = (response as Record<string, unknown>).id;
			if (typeof id === "string" && id.trim()) {
				this._responseId = id;
			}
		}
	}

	private async processResponseToolEvent(
		event: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>
	): Promise<void> {
		const candidates = [event, event.item, event.part, event.response].filter(
			(value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
		);

		for (const candidate of candidates) {
			const output = candidate.output;
			if (Array.isArray(output)) {
				for (const item of output) {
					if (item && typeof item === "object" && !Array.isArray(item)) {
						await this.processResponseToolItem(item as Record<string, unknown>, progress);
					}
				}
			}

			await this.processResponseToolItem(candidate, progress);
		}
	}

	private async processResponseToolItem(
		item: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>
	): Promise<void> {
		const type = typeof item.type === "string" ? item.type : "";
		if (type !== "function_call" && !item.call_id && !item.name && !item.arguments && !item.delta) {
			return;
		}

		const idx = typeof item.output_index === "number" ? item.output_index : 0;
		if (this._completedToolCallIndices.has(idx)) {
			return;
		}

		const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
		const callId = this.getCallIdFromEvent(item);
		if (callId) {
			buf.id = callId;
		}
		if (typeof item.name === "string" && item.name) {
			buf.name = item.name;
		}
		const argsDelta = this.coerceText(item.delta ?? item.arguments);
		if (argsDelta) {
			buf.args = type === "function_call" || item.arguments === argsDelta ? argsDelta : buf.args + argsDelta;
		}

		this._toolCallBuffers.set(idx, buf);
		await this.tryEmitBufferedToolCall(idx, progress);
		if (this._completedToolCallIndices.has(idx)) {
			this._emittedResponsesToolCall = true;
		}
	}

	private processReasoningText(
		event: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>
	) {
		const candidates = [
			this.coerceText(event.delta),
			this.coerceText(event.text),
			this.coerceText((event as Record<string, unknown>).reasoning),
			this.coerceText((event as Record<string, unknown>).summary),
		].filter(Boolean);

		for (const chunk of candidates) {
			if (this.looksLikeReasoningConfigValue(chunk)) {
				continue;
			}
			this.bufferThinkingContent(chunk, progress);
			break;
		}
	}

	private getCallIdFromEvent(event: Record<string, unknown>): string {
		const callIdRaw = event.call_id ?? event.callId ?? event.id ?? event.item_id;
		return typeof callIdRaw === "string" ? callIdRaw : "";
	}

	async *createMessage(
		model: HFModelItem,
		systemPrompt: string,
		messages: { role: string; content: string }[],
		baseUrl: string,
		apiKey: string
	): AsyncGenerator<{ type: "text"; text: string }> {
		// Convert to Responses API format
		const input: ResponsesInputItem[] = [];

		// Add system prompt as a system message or via instructions
		if (systemPrompt) {
			input.push({
				role: "system",
				content: [{ type: "input_text", text: systemPrompt }],
				type: "message",
				id: `msg_sys_${Date.now()}`,
				status: "completed",
			});
		}

		// Add user/assistant messages
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			const role = msg.role === "user" || msg.role === "assistant" || msg.role === "system" ? msg.role : "user";
			input.push({
				role,
				content: [{ type: "input_text", text: msg.content }],
				type: "message",
				id: `msg_${Date.now()}_${i}`,
				status: "completed",
			});
		}

		// Build request body
		let requestBody: Record<string, unknown> = {
			model: model.id,
			input,
			stream: true,
		};

		requestBody = this.prepareRequestBody(requestBody, model, undefined);

		const headers = CommonApi.prepareHeaders(apiKey, model.apiMode ?? "openai-responses", model.headers);

		const url = `${baseUrl.replace(/\/+$/, "")}/responses`;

		// Make the API request
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`OpenAI Responses API request failed: [${response.status}] ${response.statusText}\n${errorText}`);
		}

		if (!response.body) {
			throw new Error("No response body from OpenAI Responses API");
		}

		// Process SSE streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {break;}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data:")) {
						continue;
					}
					const data = line.slice(5).trim();
					if (data === "[DONE]") {continue;}

					try {
						const parsed = JSON.parse(data);
						const eventType = typeof parsed.type === "string" ? parsed.type : "";

						// Only handle text output events, skip reasoning/thinking events
						const textOutputEvents = ["response.output_text.delta"];

						const isTextEvent = textOutputEvents.includes(eventType) || !eventType; // Also support events without explicit type

						if (isTextEvent) {
							// Extract text from various possible locations
							const textSources = [parsed.delta, parsed.text, parsed.content, parsed.output?.[0]?.content?.[0]?.text];

							for (const textSource of textSources) {
								if (typeof textSource === "string" && textSource) {
									yield { type: "text", text: textSource };
									break;
								}
							}
						}

						// Check for completion
						if (parsed.done || parsed.type === "response.completed" || parsed.type === "response.done") {
							break;
						}
					} catch (e) {
						console.error("[OpenAI-Responses Provider] Failed to parse SSE chunk:", e, "data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}
