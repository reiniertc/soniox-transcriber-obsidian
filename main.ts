import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";

import {
	SonioxClient,
	BrowserPermissionResolver,
} from "@soniox/client";

interface SonioxTranscriberSettings {
	transcriptFolder: string;
	sonioxRestApiUrl: string;
	sonioxApiKey: string;
	copyFrontmatter: boolean;
	transcriptionTag: string;
	model: string;
	languageHint: string;
}

const DEFAULT_SETTINGS: SonioxTranscriberSettings = {
	transcriptFolder: "Transcripties",
	sonioxRestApiUrl: "https://api.soniox.com",
	sonioxApiKey: "",
	copyFrontmatter: true,
	transcriptionTag: "transcriptiebestand",
	model: "stt-rt-v4",
	languageHint: "",
};

export default class SonioxTranscriberPlugin extends Plugin {
	settings: SonioxTranscriberSettings;

	private client: SonioxClient | null = null;
	private recorder: any = null;

	private recorderState: "stopped" | "starting" | "running" | "stopping" =
		"stopped";

	private transcriptFile: TFile | null = null;

	private transcriptBuffer = "";
	private writeTimer: number | null = null;
	private writtenText = "";

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new SonioxTranscriberSettingTab(this.app, this));

		this.addCommand({
			id: "start-soniox-transcription",
			name: "Start Soniox transcription",
			callback: async () => {
				await this.startTranscription();
			},
		});

		this.addCommand({
			id: "stop-soniox-transcription",
			name: "Stop Soniox transcription",
			callback: async () => {
				await this.stopTranscription();
			},
		});

		this.addRibbonIcon("mic", "Start Soniox transcription", async () => {
			await this.startTranscription();
		});

		this.addRibbonIcon("square", "Stop Soniox transcription", async () => {
			await this.stopTranscription();
		});
	}

	onunload() {
		void this.stopTranscription();
	}

	async startTranscription() {
		if (this.recorderState !== "stopped") {
			new Notice("Transcriptie loopt al.");
			return;
		}

		const sourceFile = this.app.workspace.getActiveFile();

		if (!sourceFile) {
			new Notice("Geen actieve aantekening.");
			return;
		}

		if (!this.settings.sonioxApiKey) {
			new Notice("Soniox API key ontbreekt.");
			return;
		}

		try {
			this.recorderState = "starting";
			this.transcriptBuffer = "";
			this.writtenText = "";

			this.transcriptFile = await this.createTranscriptFile(sourceFile);

			await this.addTranscriptLinkToSource(sourceFile, this.transcriptFile);

			await this.startSonioxRecording();

			new Notice("Soniox wordt gestart.");
		} catch (error) {
			console.error(error);
			this.resetRecorderState();
			new Notice(`Start mislukt: ${String(error)}`);
		}
	}

	private async startSonioxRecording() {
		this.client = new SonioxClient({
			config: async () => ({
				api_key: this.settings.sonioxApiKey,
			}),
			permissions: new BrowserPermissionResolver(),
		});

		const config: any = {
			model: this.settings.model || "stt-rt-v4",
			enable_endpoint_detection: true,
			auto_reconnect: true,
		};

		if (this.settings.languageHint?.trim()) {
			config.language_hints = [this.settings.languageHint.trim()];
		}

		this.recorder = this.client.realtime.record(config);

		console.log("Recorder object:", this.recorder);
		console.log("Recorder methods:", Object.keys(this.recorder));

		this.recorder.on("state_change", ({ old_state, new_state }: any) => {
			console.log(`Soniox state: ${old_state} -> ${new_state}`);

			if (new_state === "recording") {
				this.recorderState = "running";

				new Notice(`Transcriptie gestart: ${this.transcriptFile?.path}`);
			}
		});

		this.recorder.on("result", (result: any) => {
			console.log(
				"FULL SONIOX RESULT",
				JSON.stringify(result, null, 2)
			);

			const tokens = result.tokens ?? result.raw?.tokens ?? [];

			if (!Array.isArray(tokens)) {
				console.log("Geen token array gevonden");
				return;
			}

			const text = tokens
				.map((token: any) => token.text ?? "")
				.join("");

			if (!text.trim()) return;

			console.log("TEXT:", text);

			if (text.startsWith(this.writtenText)) {
				const delta = text.slice(this.writtenText.length);
				this.writtenText = text;

				if (delta) {
					this.queueTranscript(delta);
				}
			} else {
				this.queueTranscript("\n" + text);
				this.writtenText = text;
			}
		});

		this.recorder.on("endpoint", () => {
			this.queueTranscript("\n");
			this.writtenText = "";
		});

		this.recorder.on("error", (error: any) => {
			console.error("Soniox error", error);
			this.resetRecorderState();
			new Notice(`Soniox fout: ${error?.message ?? String(error)}`);
		});

		this.recorder.on("finished", async () => {
			await this.flushTranscriptBuffer();
			await this.markTranscriptCompleted();
			this.resetRecorderState();
			new Notice("Transcriptie afgerond.");
		});

// In deze Soniox SDK-versie start record(config) automatisch.
// Geen recorder.start() aanroepen.
console.log("Soniox recorder initialized");
	}

	async stopTranscription() {
if (!this.recorder) {
	console.log("Geen recorder gevonden bij stop.");
	new Notice("Er loopt geen transcriptie.");
	return;
}

		const recorderToStop = this.recorder;

		try {
			this.recorderState = "stopping";

			console.log("Stopping recorder:", recorderToStop);
			console.log("Recorder methods at stop:", Object.keys(recorderToStop));

			if (typeof recorderToStop.stop === "function") {
				await recorderToStop.stop();
			} else if (typeof recorderToStop.finish === "function") {
				await recorderToStop.finish();
			} else if (typeof recorderToStop.cancel === "function") {
				await recorderToStop.cancel();
			} else if (typeof recorderToStop.close === "function") {
				await recorderToStop.close();
			} else {
				console.log("Recorder has no known stop method:", recorderToStop);
				new Notice("Recorder heeft geen stopmethode.");
			}

			await this.flushTranscriptBuffer();
			await this.markTranscriptCompleted();

			new Notice("Transcriptie gestopt.");
		} catch (error) {
			console.error("Stop mislukt", error);
			new Notice(`Stop mislukt: ${String(error)}`);
		} finally {
			this.resetRecorderState();
		}
	}

	private resetRecorderState() {
		this.recorder = null;
		this.client = null;
		this.recorderState = "stopped";
		this.transcriptFile = null;
		this.transcriptBuffer = "";
		this.writtenText = "";

		if (this.writeTimer !== null) {
			window.clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
	}

	private async createTranscriptFile(sourceFile: TFile): Promise<TFile> {
		const folder = normalizePath(
			this.settings.transcriptFolder || "Transcripties"
		);

		await this.ensureFolder(folder);

		const transcriptPath = normalizePath(
			`${folder}/${sourceFile.basename}.md`
		);

		const existing = this.app.vault.getAbstractFileByPath(transcriptPath);

		if (existing instanceof TFile) {
			throw new Error(`Transcriptiebestand bestaat al: ${transcriptPath}`);
		}

		const sourceFrontmatter =
			this.app.metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};

		const frontmatter: Record<string, unknown> = {};

		if (this.settings.copyFrontmatter) {
			for (const [key, value] of Object.entries(sourceFrontmatter)) {
				if (key !== "position") {
					frontmatter[key] = value;
				}
			}
		}

		frontmatter.source_note = this.makeWikiLink(sourceFile);
		frontmatter.status = "live";
		frontmatter.created = new Date().toISOString();

		const content = `${this.toYaml(frontmatter)}

# Transcriptie

`;

		return await this.app.vault.create(transcriptPath, content);
	}

	private makeWikiLink(file: TFile): string {
		const pathWithoutExtension = file.path.replace(/\.md$/, "");
		return `[[${pathWithoutExtension}|${file.basename}]]`;
	}

	private async addTranscriptLinkToSource(
		sourceFile: TFile,
		transcriptFile: TFile
	) {
		const link = this.makeWikiLink(transcriptFile);

		await this.app.fileManager.processFrontMatter(
			sourceFile,
			(frontmatter) => {
				frontmatter[
					this.settings.transcriptionTag || "transcriptiebestand"
				] = link;
			}
		);
	}

	private queueTranscript(text: string) {
		this.transcriptBuffer += text;

		if (this.writeTimer !== null) return;

		this.writeTimer = window.setTimeout(async () => {
			this.writeTimer = null;
			await this.flushTranscriptBuffer();
		}, 1000);
	}

	private async flushTranscriptBuffer() {
		if (!this.transcriptFile || !this.transcriptBuffer) return;

		const current = await this.app.vault.read(this.transcriptFile);
		const next = current + this.transcriptBuffer;

		this.transcriptBuffer = "";

		await this.app.vault.modify(this.transcriptFile, next);
	}

	private async markTranscriptCompleted() {
		if (!this.transcriptFile) return;

		await this.app.fileManager.processFrontMatter(
			this.transcriptFile,
			(frontmatter) => {
				frontmatter.status = "completed";
				frontmatter.completed = new Date().toISOString();
			}
		);
	}

	private async ensureFolder(folderPath: string) {
		const normalized = normalizePath(folderPath);

		if (!normalized || normalized === "/") return;

		const parts = normalized.split("/");
		let current = "";

		for (const part of parts) {
			current = current ? `${current}/${part}` : part;

			if (!this.app.vault.getAbstractFileByPath(current)) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private toYaml(data: Record<string, unknown>): string {
		const lines = ["---"];

		for (const [key, value] of Object.entries(data)) {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		}

		lines.push("---");

		return lines.join("\n");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SonioxTranscriberSettingTab extends PluginSettingTab {
	plugin: SonioxTranscriberPlugin;

	constructor(app: App, plugin: SonioxTranscriberPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", {
			text: "Soniox Transcriber",
		});

		new Setting(containerEl)
			.setName("Transcriptiemap")
			.setDesc("Relatief ten opzichte van de root van de Obsidian-kluis.")
			.addText((text) =>
				text
					.setPlaceholder("Transcripties")
					.setValue(this.plugin.settings.transcriptFolder)
					.onChange(async (value) => {
						this.plugin.settings.transcriptFolder =
							value.trim() || "Transcripties";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Soniox REST API URL")
			.setDesc("Voor toekomstige batch-functionaliteit.")
			.addText((text) =>
				text
					.setPlaceholder("https://api.soniox.com")
					.setValue(this.plugin.settings.sonioxRestApiUrl)
					.onChange(async (value) => {
						this.plugin.settings.sonioxRestApiUrl =
							value.trim() || "https://api.soniox.com";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Soniox API key")
			.setDesc("Wordt lokaal opgeslagen.")
			.addText((text) => {
				text.inputEl.type = "password";

				text
					.setPlaceholder("API key")
					.setValue(this.plugin.settings.sonioxApiKey)
					.onChange(async (value) => {
						this.plugin.settings.sonioxApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Copy frontmatter info in transcription")
			.setDesc("Kopieert frontmatter naar transcriptiebestand.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.copyFrontmatter)
					.onChange(async (value) => {
						this.plugin.settings.copyFrontmatter = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Transcription tag")
			.setDesc("Frontmatterveld in originele aantekening.")
			.addText((text) =>
				text
					.setPlaceholder("transcriptiebestand")
					.setValue(this.plugin.settings.transcriptionTag)
					.onChange(async (value) => {
						this.plugin.settings.transcriptionTag =
							value.trim() || "transcriptiebestand";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Soniox model")
			.setDesc("Realtime speech-to-text model.")
			.addText((text) =>
				text
					.setPlaceholder("stt-rt-v4")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim() || "stt-rt-v4";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Language hint")
			.setDesc("Bijvoorbeeld nl of en. Leeg = auto detect.")
			.addText((text) =>
				text
					.setPlaceholder("")
					.setValue(this.plugin.settings.languageHint)
					.onChange(async (value) => {
						this.plugin.settings.languageHint = value.trim();
						await this.plugin.saveSettings();
					})
			);
	}
}