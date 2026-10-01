import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/core/errors";
import { RoomWorkspaces } from "../src/adapters/shared/roomWorkspace";
import { roomWorkspacePath, tmpRoot } from "./testUtils";

describe("RoomWorkspaces", () => {
  it("creates each room's folder under <cwd>/.band-workspaces", () => {
    const root = tmpRoot()
    const workspaces = new RoomWorkspaces({ cwd: root })

    const workspace = workspaces.claim("room-1")

    expect(workspace).toBe(roomWorkspacePath(root, "room-1"))
    expect(existsSync(workspace)).toBe(true)
  })

  it("defaults the root to the process working directory", () => {
    const root = tmpRoot()
    const previous = process.cwd()
    process.chdir(root)
    try {
      expect(new RoomWorkspaces({}).claim("room-1")).toBe(roomWorkspacePath(root, "room-1"))
    } finally {
      process.chdir(previous)
    }
  })

  it("uses workspaceForRoom's folder, creating it", () => {
    const root = tmpRoot()
    const workspaces = new RoomWorkspaces({ workspaceForRoom: (roomId) => path.join(root, "custom", roomId) })

    expect(workspaces.claim("room-1")).toBe(path.join(realpathSync(root), "custom", "room-1"))
  })

  it("rejects cwd together with workspaceForRoom", () => {
    expect(() => new RoomWorkspaces({ cwd: tmpRoot(), workspaceForRoom: () => tmpRoot() }))
      .toThrow(ValidationError)
  })

  it("rejects a relative workspace path", () => {
    const workspaces = new RoomWorkspaces({ workspaceForRoom: (roomId) => roomId })

    expect(() => workspaces.claim("room-1")).toThrow(/must be an absolute path/)
  })

  it("refuses to give one folder to two rooms, even through a symlink", () => {
    const root = tmpRoot()
    const shared = path.join(root, "shared")
    mkdirSync(shared)
    symlinkSync(shared, path.join(root, "link"))
    const workspaces = new RoomWorkspaces({
      workspaceForRoom: (roomId) => path.join(root, roomId === "room-a" ? "shared" : "link"),
    })

    workspaces.claim("room-a")

    expect(() => workspaces.claim("room-b")).toThrow(/already in use by room room-a/)
  })

  it("lets a room claim its own folder again", () => {
    const workspaces = new RoomWorkspaces({ cwd: tmpRoot() })

    expect(workspaces.claim("room-1")).toBe(workspaces.claim("room-1"))
  })

  it("hands a released folder to another room and keeps it on disk", () => {
    const root = tmpRoot()
    const workspaces = new RoomWorkspaces({ workspaceForRoom: () => path.join(root, "shared") })
    const workspace = workspaces.claim("room-a")

    workspaces.release("room-a")

    expect(existsSync(workspace)).toBe(true)
    expect(workspaces.claim("room-b")).toBe(workspace)
  })

  it("ignores a release from a room that does not hold the folder", () => {
    const root = tmpRoot()
    const workspaces = new RoomWorkspaces({ workspaceForRoom: () => path.join(root, "shared") })
    workspaces.claim("room-a")

    workspaces.release("room-b")

    expect(() => workspaces.claim("room-b")).toThrow(/already in use by room room-a/)
  })

  it.each(["..", "../escape", "a/../..", ".", "", "/etc"])("rejects room id %j, which leaves the room folder root", (roomId) => {
    const workspaces = new RoomWorkspaces({ cwd: tmpRoot() })

    expect(() => workspaces.claim(roomId)).toThrow(/does not name a folder inside/)
  })

  it("accepts a room id that only starts with two dots", () => {
    const root = tmpRoot()

    expect(new RoomWorkspaces({ cwd: root }).claim("..room")).toBe(roomWorkspacePath(root, "..room"))
  })
})
