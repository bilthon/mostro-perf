import { EventEmitter } from 'events'
import { IOrderStore } from '../interfaces'
import { Order } from '../types'
import { MostroEvent } from '../mostro'

export class OrderStore extends EventEmitter implements IOrderStore {
  orders: Order[] = []

  constructor() {
    super()
  }

  updateOrder(order: Order, isPublic: boolean): void {
    const index = this.orders.findIndex(o => o.id === order.id)
    if (index !== -1) {
      this.orders[index] = { ...this.orders[index], ...order }
    } else {
      this.orders.push(order)
    }
    this.emit('orderUpdated', order, isPublic)
  }

  addOrder(orderData: { order: Order, event: MostroEvent }): void {
    const { order, event } = orderData
    this.orders.push(order)
    this.emit('orderAdded', order, event)
  }

  getOrders(): Order[] {
    return this.orders
  }

  getOrderById(id: string): Order | undefined {
    return this.orders.find(order => order.id === id)
  }

  // Additional methods that might be useful
  removeOrder(id: string): void {
    const index = this.orders.findIndex(order => order.id === id)
    if (index !== -1) {
      this.orders.splice(index, 1)
      this.emit('orderRemoved', id)
    }
  }

  clearOrders(): void {
    this.orders = []
    this.emit('ordersCleared')
  }
}

export function useOrders() {
  return new OrderStore()
}
