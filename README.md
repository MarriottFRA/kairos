# Planning Tool - Technical Overview

**Architecture**: Electron + React desktop application with modular IPC architecture

## Core Structure

### Entry Points
- `main.ts:402` - Electron main process, initializes IPC system via `initializeIpc()`
- `renderer.ts:42` - React renderer entry, loads `app.tsx`
- `app.tsx:17` - React Router setup with route definitions

### Process Architecture
- **Main Process** (`main.ts`) - Node.js backend with auth, DB, IPC handlers
- **Renderer Process** (`app.tsx` + routes) - React frontend UI
- **Preload Bridge** (`preload.ts:52`) - Secure IPC communication layer

## IPC Communication System

### Modular Registry (`src/ipc/registry.ts:176`)
- Centralized handler registration with middleware chain
- Type-safe request/response wrapping
- Built-in error handling, logging, performance monitoring

### Handler Organization
- `src/ipc/handlers/auth.ts` - Authentication handlers
- `src/ipc/handlers/database.ts` - Database operations
- Middleware: security, rate limiting, error handling

### Frontend Bridge (`preload.ts:52`)
```typescript
window.ipcApi.sendIpcRequest(channel, ...args) // Main communication
window.ipcApi.onAuthSuccess/Error/Logout() // Auth events
```

## Database Layer

### Local SQLite (`local_db.ts:147`)
- LibSQL client with encryption support
- 4 core tables: departments, accounts, department_accounts, financial_data
- Batch operations for performance

### Key Functions
- `get12Periods()` - Financial data queries with period aggregation
- `update12Periods()` - Bulk financial updates
- CRUD operations for accounts, departments, combos

## Frontend Routing

### React Router (`app.tsx:17`)
- `/` - Landing page
- `/signed-in-landing` - Authenticated dashboard with nested routes:
  - `report`, `data-table`, `create-new`, `coa`

## Adding New Handlers

### Backend (main ↔ renderer communication)
1. Create handler in `src/ipc/handlers/[module].ts`
2. Export from `src/ipc/handlers/index.ts`
3. Register in `src/ipc/index.ts:37-46`
4. Add channel constant to `preload.ts:6-22`

### Frontend (renderer → main calls)
```typescript
const result = await window.ipcApi.sendIpcRequest('new-channel', data);
```

## Development Workflow

### Key Commands
- `npm start` - Dev mode with hot reload
- `npm run lint` - ESLint validation
- `npm run package` - Build distributables

### Extension Points
- New IPC handlers: `src/ipc/handlers/[name].ts`
- New routes: Add to `app.tsx:17` router config
- New UI components: `src/routes/customComponents/`
- Database functions: Add to `local_db.ts` and wire through IPC

### Auth Flow
OIDC PKCE via system browser → deep link callback → token storage

---