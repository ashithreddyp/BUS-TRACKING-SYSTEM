export default function normalizeBus(bus) {
  return {
    ...bus,
    id: String(bus.id || bus._id),
    routeId: bus.routeId ? String(bus.routeId) : null,
    nextStop: bus.nextStop ? String(bus.nextStop) : null,
    locationArr: bus.location
      ? [bus.location.lat ?? bus.location[0], bus.location.lng ?? bus.location[1]]
      : null
  };
}
