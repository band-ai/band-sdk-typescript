import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { ValidationError } from "../../core/errors";

/** Folder under the adapter's `cwd` that holds one workspace per room. */
export const DEFAULT_WORKSPACE_DIRECTORY = ".band-workspaces";

/** Returns the absolute directory a room's agent process runs in. */
export type WorkspaceForRoom = (roomId: string) => string;

export interface RoomWorkspaceOptions {
  /** Root for `<cwd>/.band-workspaces/<roomId>`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Replaces the default layout. Must return an absolute path. */
  workspaceForRoom?: WorkspaceForRoom;
}

/**
 * Hands each live room its own directory and refuses to give one directory to
 * two rooms. Folders are created on claim and never deleted.
 */
export class RoomWorkspaces {
  private readonly resolve: WorkspaceForRoom;
  private readonly roomByPath = new Map<string, string>();
  private readonly pathByRoom = new Map<string, string>();

  public constructor(options: RoomWorkspaceOptions) {
    this.resolve = workspaceResolver(options);
  }

  /** Creates and claims the room's directory and returns its real path. */
  public claim(roomId: string): string {
    const requested = this.resolve(roomId);
    if (!path.isAbsolute(requested)) {
      throw new ValidationError(`Workspace for room ${roomId} must be an absolute path, got "${requested}"`);
    }
    // `realpathSync` throws on a missing path, so the folder has to exist first.
    mkdirSync(requested, { recursive: true });
    // Real paths, so two symlinks to one folder count as one workspace.
    const workspace = realpathSync(requested);
    const owner = this.roomByPath.get(workspace);
    if (owner !== undefined && owner !== roomId) {
      throw new ValidationError(`Workspace ${workspace} is already in use by room ${owner}`);
    }
    this.release(roomId);
    this.roomByPath.set(workspace, roomId);
    this.pathByRoom.set(roomId, workspace);
    return workspace;
  }

  public release(roomId: string): void {
    const workspace = this.pathByRoom.get(roomId);
    if (workspace === undefined) {
      return;
    }
    this.pathByRoom.delete(roomId);
    this.roomByPath.delete(workspace);
  }
}

function workspaceResolver({ cwd, workspaceForRoom }: RoomWorkspaceOptions): WorkspaceForRoom {
  if (workspaceForRoom) {
    if (cwd !== undefined) {
      throw new ValidationError("Set either cwd or workspaceForRoom, not both");
    }
    return workspaceForRoom;
  }
  const root = path.resolve(cwd ?? process.cwd(), DEFAULT_WORKSPACE_DIRECTORY);
  return (roomId) => {
    const workspace = path.resolve(root, roomId);
    if (!isStrictlyInside(root, workspace)) {
      throw new ValidationError(`Room id ${JSON.stringify(roomId)} does not name a folder inside ${root}`);
    }
    return workspace;
  };
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
