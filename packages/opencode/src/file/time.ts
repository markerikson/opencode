import { DateTime, Effect, Layer, Semaphore, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Flag } from "@/flag/flag"
import type { SessionID } from "@/session/schema"
import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })

  export type Stamp = {
    readonly read: Date
    readonly mtime: number | undefined
    readonly ctime: number | undefined
    readonly size: number | undefined
  }

  const stamp = Effect.fnUntraced(function* (file: string) {
    const stat = Filesystem.stat(file)
    const size = typeof stat?.size === "bigint" ? Number(stat.size) : stat?.size
    return {
      read: yield* DateTime.nowAsDate,
      mtime: stat?.mtime?.getTime(),
      ctime: stat?.ctime?.getTime(),
      size,
    }
  })

  const session = (reads: Map<SessionID, Map<string, Stamp>>, sessionID: SessionID) => {
    const value = reads.get(sessionID)
    if (value) return value

    const next = new Map<string, Stamp>()
    reads.set(sessionID, next)
    return next
  }

  interface State {
    reads: Map<SessionID, Map<string, Stamp>>
    locks: Map<string, Semaphore.Semaphore>
  }

  export interface Interface {
    readonly read: (sessionID: SessionID, file: string) => Effect.Effect<void>
    readonly get: (sessionID: SessionID, file: string) => Effect.Effect<Date | undefined>
    readonly assert: (sessionID: SessionID, filepath: string) => Effect.Effect<void>
    readonly withLock: <T>(filepath: string, fn: () => Promise<T>) => Effect.Effect<T>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/FileTime") {}

  // Normalize path separators to forward slashes for consistent lookup
  // (Windows paths may use backslashes, but we want consistent keys)
  function normalizePath(filepath: string): string {
    return filepath.replace(/\\/g, "/")
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const disableCheck = yield* Flag.OPENCODE_DISABLE_FILETIME_CHECK
      const state = yield* InstanceState.make<State>(
        Effect.fn("FileTime.state")(() =>
          Effect.succeed({
            reads: new Map<SessionID, Map<string, Stamp>>(),
            locks: new Map<string, Semaphore.Semaphore>(),
          }),
        ),
      )

      const getLock = Effect.fn("FileTime.lock")(function* (filepath: string) {
        const locks = (yield* InstanceState.get(state)).locks
        const normalizedPath = normalizePath(filepath)
        const lock = locks.get(normalizedPath)
        if (lock) return lock

        const next = Semaphore.makeUnsafe(1)
        locks.set(normalizedPath, next)
        return next
      })

      const read = Effect.fn("FileTime.read")(function* (sessionID: SessionID, file: string) {
        const reads = (yield* InstanceState.get(state)).reads
        const normalizedPath = normalizePath(file)
        log.info("read", { sessionID, file: normalizedPath })
        session(reads, sessionID).set(file, yield* stamp(normalizedPath))
      })

      const get = Effect.fn("FileTime.get")(function* (sessionID: SessionID, file: string) {
        const reads = (yield* InstanceState.get(state)).reads
        const normalizedPath = normalizePath(file)
        return reads.get(sessionID)?.get(normalizedPath)?.read
      })

      const assert = Effect.fn("FileTime.assert")(function* (sessionID: SessionID, filepath: string) {
        if (disableCheck) return

        const reads = (yield* InstanceState.get(state)).reads

        const normalizedPath = normalizePath(filepath)
        const time = reads.get(sessionID)?.get(normalizedPath)
        if (!time)
          throw new Error(`You must read file ${normalizedPath} before overwriting it. Use the Read tool first`)

        const next = yield* stamp(normalizedPath)
        const changed = next.mtime !== time.mtime || next.ctime !== time.ctime || next.size !== time.size
        if (!changed) return

        throw new Error(
          `File ${normalizedPath} has been modified since it was last read.\nLast modification: ${new Date(next.mtime ?? next.read.getTime()).toISOString()}\nLast read: ${time.read.toISOString()}\n\nPlease read the file again before modifying it.`,
        )
      })

      const withLock = Effect.fn("FileTime.withLock")(function* <T>(filepath: string, fn: () => Promise<T>) {
        const normalizedPath = normalizePath(filepath)
        return yield* Effect.promise(fn).pipe((yield* getLock(normalizedPath)).withPermits(1))
      })

      return Service.of({ read, get, assert, withLock })
    }),
  ).pipe(Layer.orDie)

  const { runPromise } = makeRuntime(Service, layer)

  export function read(sessionID: SessionID, file: string) {
    return runPromise((s) => s.read(sessionID, file))
  }

  export function get(sessionID: SessionID, file: string) {
    return runPromise((s) => s.get(sessionID, file))
  }

  export async function assert(sessionID: SessionID, filepath: string) {
    return runPromise((s) => s.assert(sessionID, filepath))
  }

  export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    return runPromise((s) => s.withLock(filepath, fn))
  }
}
