import { MedusaError } from "medusa-core-utils"
import { EntityManager } from "typeorm"
import { ShippingProfileService } from "."
import { TransactionBaseService } from "../interfaces"
import { Fulfillment, LineItem, ShippingMethod } from "../models"
import { FulfillmentRepository } from "../repositories/fulfillment"
import { LineItemRepository } from "../repositories/line-item"
import { TrackingLinkRepository } from "../repositories/tracking-link"
import { FindConfig } from "../types/common"
import {
  CreateFulfillmentOrder,
  CreateShipmentConfig,
  FulfillmentItemPartition,
  FulFillmentItemType,
} from "../types/fulfillment"
import { buildQuery, isDefined } from "../utils"
import FulfillmentProviderService from "./fulfillment-provider"
import LineItemService from "./line-item"
import TotalsService from "./totals"

type InjectedDependencies = {
  manager: EntityManager
  totalsService: TotalsService
  shippingProfileService: ShippingProfileService
  lineItemService: LineItemService
  fulfillmentProviderService: FulfillmentProviderService
  fulfillmentRepository: typeof FulfillmentRepository
  trackingLinkRepository: typeof TrackingLinkRepository
  lineItemRepository: typeof LineItemRepository
}

/**
 * Handles Fulfillments
 */
class FulfillmentService extends TransactionBaseService<FulfillmentService> {
  protected manager_: EntityManager
  protected transactionManager_: EntityManager | undefined

  protected readonly totalsService_: TotalsService
  protected readonly lineItemService_: LineItemService
  protected readonly shippingProfileService_: ShippingProfileService
  protected readonly fulfillmentProviderService_: FulfillmentProviderService
  protected readonly fulfillmentRepository_: typeof FulfillmentRepository
  protected readonly trackingLinkRepository_: typeof TrackingLinkRepository
  protected readonly lineItemRepository_: typeof LineItemRepository

  constructor({
    manager,
    totalsService,
    fulfillmentRepository,
    trackingLinkRepository,
    shippingProfileService,
    lineItemService,
    fulfillmentProviderService,
    lineItemRepository,
  }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0])

    this.manager_ = manager

    this.lineItemRepository_ = lineItemRepository
    this.totalsService_ = totalsService
    this.fulfillmentRepository_ = fulfillmentRepository
    this.trackingLinkRepository_ = trackingLinkRepository
    this.shippingProfileService_ = shippingProfileService
    this.lineItemService_ = lineItemService
    this.fulfillmentProviderService_ = fulfillmentProviderService
  }

  partitionItems_(
    shippingMethods: ShippingMethod[],
    items: LineItem[]
  ): FulfillmentItemPartition[] {
    const partitioned: FulfillmentItemPartition[] = []
    // partition order items to their dedicated shipping method
    for (const method of shippingMethods) {
      const temp: FulfillmentItemPartition = {
        shipping_method: method,
        items: [],
      }

      // for each method find the items in the order, that are associated
      // with the profile on the current shipping method
      if (shippingMethods.length === 1) {
        temp.items = items
      } else {
        const methodProfile = method.shipping_option.profile_id

        temp.items = items.filter(({ variant }) => {
          variant.product.profile_id === methodProfile
        })
      }
      partitioned.push(temp)
    }
    return partitioned
  }

  /**
   * Retrieves the order line items, given an array of items.
   * @param order - the order to get line items from
   * @param items - the items to get
   * @param transformer - a function to apply to each of the items
   *    retrieved from the order, should return a line item. If the transformer
   *    returns an undefined value the line item will be filtered from the
   *    returned array.
   * @return the line items generated by the transformer.
   */
  async getFulfillmentItems_(
    order: CreateFulfillmentOrder,
    items: FulFillmentItemType[]
  ): Promise<(LineItem | null)[]> {
    const toReturn = await Promise.all(
      items.map(async ({ item_id, quantity }) => {
        const item = order.items.find((i) => i.id === item_id)
        return this.validateFulfillmentLineItem_(item, quantity)
      })
    )

    return toReturn.filter((i) => !!i)
  }

  /**
   * Checks that a given quantity of a line item can be fulfilled. Fails if the
   * fulfillable quantity is lower than the requested fulfillment quantity.
   * Fulfillable quantity is calculated by subtracting the already fulfilled
   * quantity from the quantity that was originally purchased.
   * @param item - the line item to check has sufficient fulfillable
   *   quantity.
   * @param quantity - the quantity that is requested to be fulfilled.
   * @return a line item that has the requested fulfillment quantity
   *   set.
   */
  validateFulfillmentLineItem_(
    item: LineItem | undefined,
    quantity: number
  ): LineItem | null {
    const manager = this.transactionManager_ ?? this.manager_
    const lineItemRepo = manager.getCustomRepository(this.lineItemRepository_)

    if (!item) {
      // This will in most cases be called by a webhook so to ensure that
      // things go through smoothly in instances where extra items outside
      // of Medusa are added we allow unknown items
      return null
    }

    if (quantity > item.quantity - item.fulfilled_quantity) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Cannot fulfill more items than have been purchased"
      )
    }
    return lineItemRepo.create({
      ...item,
      quantity,
    })
  }

  /**
   * Retrieves a fulfillment by its id.
   * @param id - the id of the fulfillment to retrieve
   * @param config - optional values to include with fulfillmentRepository query
   * @return the fulfillment
   */
  async retrieve(
    id: string,
    config: FindConfig<Fulfillment> = {}
  ): Promise<Fulfillment> {
    const manager = this.manager_
    const fulfillmentRepository = manager.getCustomRepository(
      this.fulfillmentRepository_
    )

    const query = buildQuery({ id }, config)

    const fulfillment = await fulfillmentRepository.findOne(query)

    if (!fulfillment) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Fulfillment with id: ${id} was not found`
      )
    }
    return fulfillment
  }

  /**
   * Creates an order fulfillment
   * If items needs to be fulfilled by different provider, we make
   * sure to partition those items, and create fulfillment for
   * those partitions.
   * @param order - order to create fulfillment for
   * @param itemsToFulfill - the items in the order to fulfill
   * @param custom - potential custom values to add
   * @return the created fulfillments
   */
  async createFulfillment(
    order: CreateFulfillmentOrder,
    itemsToFulfill: FulFillmentItemType[],
    custom: Partial<Fulfillment> = {}
  ): Promise<Fulfillment[]> {
    return await this.atomicPhase_(async (manager) => {
      const fulfillmentRepository = manager.getCustomRepository(
        this.fulfillmentRepository_
      )

      const lineItems = await this.getFulfillmentItems_(order, itemsToFulfill)

      const { shipping_methods } = order

      // partition order items to their dedicated shipping method
      const fulfillments = this.partitionItems_(
        shipping_methods,
        lineItems as LineItem[]
      )

      const created = await Promise.all(
        fulfillments.map(async ({ shipping_method, items }) => {
          const ful = fulfillmentRepository.create({
            ...custom,
            provider_id: shipping_method.shipping_option.provider_id,
            items: items.map((i) => ({ item_id: i.id, quantity: i.quantity })),
            data: {},
          })

          const result = await fulfillmentRepository.save(ful)

          result.data =
            await this.fulfillmentProviderService_.createFulfillment(
              shipping_method,
              items,
              { ...order },
              { ...result }
            )

          return fulfillmentRepository.save(result)
        })
      )

      return created
    })
  }

  /**
   * Cancels a fulfillment with the fulfillment provider. Will decrement the
   * fulfillment_quantity on the line items associated with the fulfillment.
   * Throws if the fulfillment has already been shipped.
   * @param fulfillmentOrId - the fulfillment object or id.
   * @return the result of the save operation
   *
   */
  async cancelFulfillment(
    fulfillmentOrId: Fulfillment | string
  ): Promise<Fulfillment> {
    return await this.atomicPhase_(async (manager) => {
      const id =
        typeof fulfillmentOrId === "string"
          ? fulfillmentOrId
          : fulfillmentOrId.id

      const fulfillment = await this.retrieve(id, {
        relations: ["items", "claim_order", "swap"],
      })

      if (fulfillment.shipped_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `The fulfillment has already been shipped. Shipped fulfillments cannot be canceled`
        )
      }

      await this.fulfillmentProviderService_.cancelFulfillment(fulfillment)

      fulfillment.canceled_at = new Date()

      const lineItemServiceTx = this.lineItemService_.withTransaction(manager)

      for (const fItem of fulfillment.items) {
        const item = await lineItemServiceTx.retrieve(fItem.item_id)
        const fulfilledQuantity = item.fulfilled_quantity - fItem.quantity
        await lineItemServiceTx.update(item.id, {
          fulfilled_quantity: fulfilledQuantity,
        })
      }

      const fulfillmentRepo = manager.getCustomRepository(
        this.fulfillmentRepository_
      )
      const canceled = await fulfillmentRepo.save(fulfillment)
      return canceled
    })
  }

  /**
   * Creates a shipment by marking a fulfillment as shipped. Adds
   * tracking links and potentially more metadata.
   * @param fulfillmentId - the fulfillment to ship
   * @param trackingLinks - tracking links for the shipment
   * @param config - potential configuration settings, such as no_notification and metadata
   * @return  the shipped fulfillment
   */
  async createShipment(
    fulfillmentId: string,
    trackingLinks?: { tracking_number: string }[],
    config: CreateShipmentConfig = {
      metadata: {},
      no_notification: undefined,
    }
  ): Promise<Fulfillment> {
    const { metadata, no_notification } = config

    return await this.atomicPhase_(async (manager) => {
      const fulfillmentRepository = manager.getCustomRepository(
        this.fulfillmentRepository_
      )
      const trackingLinkRepo = manager.getCustomRepository(
        this.trackingLinkRepository_
      )

      const fulfillment = await this.retrieve(fulfillmentId, {
        relations: ["items"],
      })

      if (fulfillment.canceled_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Fulfillment has been canceled"
        )
      }

      const now = new Date()
      fulfillment.shipped_at = now

      fulfillment.tracking_links = (trackingLinks || []).map((tl) =>
        trackingLinkRepo.create(tl)
      )

      if (isDefined(no_notification)) {
        fulfillment.no_notification = no_notification
      }

      fulfillment.metadata = {
        ...fulfillment.metadata,
        ...metadata,
      }

      return await fulfillmentRepository.save(fulfillment)
    })
  }
}

export default FulfillmentService
