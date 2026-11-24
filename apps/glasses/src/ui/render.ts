// Sends pages to the glasses. createStartUpPageContainer runs exactly once;
// after that a page whose layout is unchanged is updated in place with
// textContainerUpgrade (no flicker), and any layout or menu change uses
// rebuildPageContainer, which always carries the contextual menu.
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { layoutKey, type Page, type TextBox } from './layout'

export interface MenuItem {
  id: number
  label: string
}

/** The bridge calls the UI needs (tests pass a fake). */
export type BridgeUi = Pick<
  EvenAppBridge,
  | 'createStartUpPageContainer'
  | 'rebuildPageContainer'
  | 'textContainerUpgrade'
  | 'shutDownPageContainer'
  | 'getLocalStorage'
  | 'setLocalStorage'
>

const BRIDGE_TIMEOUT_MS = 5_000

/** Runs bridge calls one at a time, each capped so a lost reply cannot stall the app. */
export class BridgeQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(call: () => Promise<T>, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<T> {
    const task = this.tail.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('bridge call timed out')),
            timeoutMs,
          )
          call().then(
            (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            (error: unknown) => {
              clearTimeout(timer)
              reject(error instanceof Error ? error : new Error(String(error)))
            },
          )
        }),
    )
    this.tail = task.catch(() => undefined)
    return task
  }
}

/** The SDK container payload for a page (also checked by the SDK validator in tests). */
export function containers(page: Page) {
  const textObject: TextContainerProperty[] = []
  const listObject: ListContainerProperty[] = []
  page.boxes.forEach((box, index) => {
    const common = {
      xPosition: box.x,
      yPosition: box.y,
      width: box.width,
      height: box.height,
      containerID: index + 1,
      containerName: box.name,
      isEventCapture: box.capture ? 1 : 0,
    }
    if (box.kind === 'text') {
      textObject.push(
        new TextContainerProperty({
          ...common,
          borderWidth: box.border?.width ?? 0,
          borderColor: box.border?.color ?? 0,
          borderRadius: box.border?.radius ?? 0,
          paddingLength: box.padding ?? 0,
          content: box.content,
          ...(box.brightness === undefined
            ? {}
            : { textColor: box.brightness }),
        }),
      )
    } else {
      listObject.push(
        new ListContainerProperty({
          ...common,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 0,
          itemContainer: new ListItemContainerProperty({
            itemCount: box.items.length,
            itemWidth: 0,
            isItemSelectBorderEn: 1,
            itemName: box.items,
          }),
        }),
      )
    }
  })
  return {
    containerTotalNum: page.boxes.length,
    ...(textObject.length ? { textObject } : {}),
    ...(listObject.length ? { listObject } : {}),
  }
}

export function menuObject(menu: MenuItem[]): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: menu.map(
      (item) => new MenuItemProperty({ itemID: item.id, itemName: item.label }),
    ),
  })
}

export class StartupError extends Error {
  override readonly name = 'StartupError'
}

interface Shown {
  page: Page
  key: string
}

export class Renderer {
  private shown?: Shown
  private started = false

  constructor(
    private readonly bridge: BridgeUi,
    private readonly queue: BridgeQueue,
  ) {}

  /** Forces the next show() to rebuild the whole page (after a foreground return). */
  invalidate(): void {
    this.shown = undefined
  }

  async show(
    page: Page,
    menu: MenuItem[],
  ): Promise<'created' | 'upgraded' | 'rebuilt' | 'unchanged'> {
    const key = `${layoutKey(page)}|${JSON.stringify(menu)}`
    if (!this.started) {
      const result = await this.queue.run(() =>
        this.bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({
            ...containers(page),
            menuObject: menuObject(menu),
          }),
        ),
      )
      if (result !== StartUpPageCreateResult.success)
        throw new StartupError(`startup page failed result=${result}`)
      this.started = true
      this.shown = { page, key }
      return 'created'
    }
    const shown = this.shown
    if (shown && shown.key === key) {
      const changed = page.boxes
        .map((box, index) => ({ box, index }))
        .filter(
          (entry): entry is { box: TextBox; index: number } =>
            entry.box.kind === 'text' &&
            (shown.page.boxes[entry.index] as TextBox).content !==
              entry.box.content,
        )
      if (changed.length === 0) {
        this.shown = { page, key }
        return 'unchanged'
      }
      let ok = true
      for (const { box, index } of changed) {
        ok =
          ok &&
          (await this.queue
            .run(() =>
              this.bridge.textContainerUpgrade(
                new TextContainerUpgrade({
                  containerID: index + 1,
                  containerName: box.name,
                  contentOffset: 0,
                  contentLength: 0,
                  content: box.content,
                }),
              ),
            )
            .catch(() => false))
      }
      if (ok) {
        this.shown = { page, key }
        return 'upgraded'
      }
    }
    this.shown = undefined
    const rebuilt = await this.queue
      .run(() =>
        this.bridge.rebuildPageContainer(
          new RebuildPageContainer({
            ...containers(page),
            menuObject: menuObject(menu),
          }),
        ),
      )
      .catch(() => false)
    if (!rebuilt) throw new Error(`rebuild failed screen=${page.screen}`)
    this.shown = { page, key }
    return 'rebuilt'
  }
}
