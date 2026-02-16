# oneAgent

A fully functional chat agent UI built with Next.js, shadcn/ui, and SQLite, powered by the GenAgent framework.

## Features

- **Multi-provider AI chat**: Supports Anthropic, OpenAI, Google, Groq, and 22+ other providers through GenAgent
- **Real-time streaming**: Server-Sent Events (SSE) for live streaming of AI responses
- **Tool execution display**: Visual display of tool calls (read files, execute commands, search code, etc.)
- **Conversation management**: Create, rename, and delete conversations with persistent history
- **SQLite persistence**: All conversations, messages, and settings stored locally in SQLite
- **Settings panel**: Configure provider, model, API key, and advanced options from the UI
- **Dark mode**: Beautiful dark theme by default with full shadcn/ui components
- **Responsive design**: Works on desktop and mobile with collapsible sidebar
- **Markdown rendering**: Rich markdown display with syntax highlighting for code blocks
- **Memory and context**: Leverages GenAgent's memory system and context management

## Tech Stack

- **Next.js 16** with App Router and Turbopack
- **shadcn/ui** for UI components (Button, Dialog, ScrollArea, Sheet, etc.)
- **Tailwind CSS v4** with typography plugin
- **better-sqlite3** for local SQLite database
- **GenAgent** for AI agent capabilities (tool execution, memory, sessions, streaming)
- **react-markdown** with remark-gfm for markdown rendering
- **lucide-react** for icons

## Getting Started

### Prerequisites

- Node.js >= 20
- GenAgent parent project built (`npm run build` in parent directory)

### Setup

1. Install dependencies:

```bash
cd oneagent
npm install
```

2. Configure your API key (choose one method):

**Method A: Settings UI** - Start the app and configure via the Settings dialog (gear icon)

**Method B: Environment variables** - Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Then edit `.env.local` with your API key:

```env
ANTHROPIC_API_KEY=sk-xxx
```

3. Start the development server:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

### Build for Production

```bash
npm run build
npm start
```

## Project Structure

```
oneagent/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── chat/          # SSE streaming chat endpoint
│   │   │   ├── conversations/ # CRUD for conversations
│   │   │   └── settings/      # Settings management
│   │   ├── globals.css        # Global styles with dark theme
│   │   ├── layout.tsx         # Root layout with providers
│   │   └── page.tsx           # Main page
│   ├── components/
│   │   ├── chat/
│   │   │   ├── chat-area.tsx       # Main chat view with messages
│   │   │   ├── chat-input.tsx      # Message input with send/stop
│   │   │   ├── chat-layout.tsx     # Full layout with sidebar
│   │   │   ├── chat-sidebar.tsx    # Conversation list sidebar
│   │   │   ├── message-bubble.tsx  # Message rendering (user/AI/tool)
│   │   │   └── settings-dialog.tsx # Provider/model settings
│   │   └── ui/                     # shadcn components
│   ├── hooks/
│   │   ├── use-chat.ts        # Chat state management hook
│   │   └── use-mobile.ts      # Mobile detection hook
│   └── lib/
│       ├── agent.ts           # GenAgent wrapper (server-side)
│       ├── db.ts              # SQLite database layer
│       ├── types.ts           # Shared type definitions
│       └── utils.ts           # Utility functions
├── oneagent.db                # SQLite database (auto-created)
├── next.config.ts             # Next.js configuration
└── package.json
```

## Architecture

### Data Flow

1. User types a message in the chat input
2. Client sends POST to `/api/chat` with conversationId and message
3. Server creates an Agent instance (or reuses existing one)
4. Agent processes the message through the GenAgent dual-loop architecture
5. Events stream back via SSE (message deltas, tool executions, errors)
6. Client renders streaming content in real-time
7. On completion, message is persisted to SQLite

### Database Schema

- **conversations** - Chat sessions with title, provider, model, timestamps
- **messages** - Individual messages with role, content, tool info
- **settings** - Key-value store for provider config, API keys, preferences

### GenAgent Integration

oneAgent uses GenAgent as a server-side dependency through API routes. The agent supports:

- **Streaming responses** via EventStream pattern
- **Tool execution**: read, write, edit, exec, list, grep, memory operations
- **Context management**: Automatic pruning and compaction of conversation history
- **Memory**: Long-term memory search and storage
- **Skills**: Skill matching and execution
- **Multi-provider**: Switch between AI providers without code changes

## License

MIT
