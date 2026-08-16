import { randomUUID } from "node:crypto";
import type { ModelMessage } from "../llm/types";
import type {
  AgentMode,
  ConversationSummary,
  DisplayMessage,
  TokenUsage
} from "../shared/protocol";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  mode: AgentMode;
  modelMessages: ModelMessage[];
  displayMessages: DisplayMessage[];
  usage: TokenUsage;
}

export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

interface PersistedState {
  activeConversationId?: string;
  conversations: Conversation[];
}

const storageKey = "localCodingAgent.conversations.v1";

export class ConversationRepository {
  private conversations: Conversation[];
  private activeConversationId: string;

  public constructor(private readonly storage: MementoLike) {
    const persisted = storage.get<PersistedState>(storageKey, {
      conversations: []
    });
    this.conversations = persisted.conversations
      .filter(isConversation)
      .slice(0, 30);
    const persistedActive = persisted.activeConversationId;
    if (
      persistedActive !== undefined &&
      this.conversations.some(
        (conversation) => conversation.id === persistedActive
      )
    ) {
      this.activeConversationId = persistedActive;
    } else {
      this.activeConversationId = this.createConversationInternal("New task").id;
    }
  }

  public get active(): Conversation {
    const conversation = this.conversations.find(
      (candidate) => candidate.id === this.activeConversationId
    );
    if (conversation === undefined) {
      throw new Error("The active conversation no longer exists.");
    }
    return conversation;
  }

  public get summaries(): ConversationSummary[] {
    return this.conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt
    }));
  }

  public async createConversation(): Promise<Conversation> {
    const conversation = this.createConversationInternal("New task");
    await this.persist();
    return conversation;
  }

  public async selectConversation(id: string): Promise<boolean> {
    if (!this.conversations.some((conversation) => conversation.id === id)) {
      return false;
    }
    this.activeConversationId = id;
    await this.persist();
    return true;
  }

  public async clearActive(): Promise<void> {
    const conversation = this.active;
    conversation.modelMessages = [];
    conversation.displayMessages = [];
    conversation.usage = emptyUsage();
    conversation.title = "New task";
    touch(conversation);
    await this.persist();
  }

  public async setMode(mode: AgentMode): Promise<void> {
    this.active.mode = mode;
    touch(this.active);
    await this.persist();
  }

  public async appendModelMessage(message: ModelMessage): Promise<void> {
    this.active.modelMessages.push(message);
    touch(this.active);
    await this.persist();
  }

  public async replaceModelMessages(messages: ModelMessage[]): Promise<void> {
    this.active.modelMessages = messages;
    touch(this.active);
    await this.persist();
  }

  public async addDisplayMessage(
    role: DisplayMessage["role"],
    content: string,
    state: DisplayMessage["state"]
  ): Promise<DisplayMessage> {
    const message: DisplayMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
      state
    };
    this.active.displayMessages.push(message);
    if (role === "user" && this.active.title === "New task") {
      this.active.title = titleFrom(content);
    }
    touch(this.active);
    await this.persist();
    return message;
  }

  public async appendDisplayContent(id: string, delta: string): Promise<void> {
    const message = this.findDisplayMessage(id);
    message.content += delta;
    touch(this.active);
  }

  public async setDisplayState(
    id: string,
    state: DisplayMessage["state"]
  ): Promise<void> {
    const message = this.findDisplayMessage(id);
    message.state = state;
    touch(this.active);
    await this.persist();
  }

  public async removeDisplayMessage(id: string): Promise<void> {
    const index = this.active.displayMessages.findIndex(
      (message) => message.id === id
    );
    if (index >= 0) {
      this.active.displayMessages.splice(index, 1);
      touch(this.active);
      await this.persist();
    }
  }

  public async updateUsage(usage: TokenUsage): Promise<void> {
    this.active.usage = usage;
    touch(this.active);
    await this.persist();
  }

  public async prepareRetry(): Promise<string | undefined> {
    const displayMessages = this.active.displayMessages;
    let lastUserIndex = -1;
    for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
      if (displayMessages[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex < 0) {
      return undefined;
    }
    const userText = displayMessages[lastUserIndex]!.content;
    this.active.displayMessages = displayMessages.slice(0, lastUserIndex + 1);

    let lastModelUserIndex = -1;
    for (
      let index = this.active.modelMessages.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (
        this.active.modelMessages[index]?.role === "user" &&
        this.active.modelMessages[index]?.content === userText
      ) {
        lastModelUserIndex = index;
        break;
      }
    }
    if (lastModelUserIndex >= 0) {
      this.active.modelMessages = this.active.modelMessages.slice(
        0,
        lastModelUserIndex + 1
      );
    }
    touch(this.active);
    await this.persist();
    return userText;
  }

  public async persist(): Promise<void> {
    this.conversations.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
    this.conversations.splice(30);
    await this.storage.update(storageKey, {
      activeConversationId: this.activeConversationId,
      conversations: this.conversations
    } satisfies PersistedState);
  }

  private createConversationInternal(title: string): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      mode: "ask",
      modelMessages: [],
      displayMessages: [],
      usage: emptyUsage()
    };
    this.conversations.unshift(conversation);
    this.activeConversationId = conversation.id;
    return conversation;
  }

  private findDisplayMessage(id: string): DisplayMessage {
    const message = this.active.displayMessages.find(
      (candidate) => candidate.id === id
    );
    if (message === undefined) {
      throw new Error(`Display message ${id} does not exist.`);
    }
    return message;
  }
}

function emptyUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimated: true
  };
}

function touch(conversation: Conversation): void {
  conversation.updatedAt = new Date().toISOString();
}

function titleFrom(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

function isConversation(value: unknown): value is Conversation {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "modelMessages" in value &&
    Array.isArray(value.modelMessages) &&
    "displayMessages" in value &&
    Array.isArray(value.displayMessages)
  );
}
