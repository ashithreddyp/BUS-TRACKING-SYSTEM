import L from "leaflet";

function createEmojiBadgeIcon({
  glyphEntity,
  variantClass,
  size = [36, 36],
  anchor = [18, 18]
}) {
  return L.divIcon({
    html: `<div class="emoji-badge ${variantClass}"><span class="emoji-glyph">${glyphEntity}</span></div>`,
    className: "emoji-icon-wrap",
    iconSize: size,
    iconAnchor: anchor
  });
}

export const busIcon = createEmojiBadgeIcon({
  glyphEntity: "&#x1F68C;",
  variantClass: "badge-bus",
  size: [38, 38],
  anchor: [19, 19]
});

export const selectedBusIcon = createEmojiBadgeIcon({
  glyphEntity: "&#x1F68C;",
  variantClass: "badge-bus-selected",
  size: [40, 40],
  anchor: [20, 20]
});

export const stopIcon = createEmojiBadgeIcon({
  glyphEntity: "&#x1F68F;",
  variantClass: "badge-stop",
  size: [36, 36],
  anchor: [18, 18]
});

export const selectedStopIcon = createEmojiBadgeIcon({
  glyphEntity: "&#x1F68F;",
  variantClass: "badge-stop-selected",
  size: [38, 38],
  anchor: [19, 19]
});

export const startPointIcon = createEmojiBadgeIcon({
  glyphEntity: "&#x1F6A9;",
  variantClass: "badge-start-point",
  size: [36, 36],
  anchor: [18, 18]
});

export const endPointIcon = createEmojiBadgeIcon({
  glyphEntity: "&#x1F3C1;",
  variantClass: "badge-end-point",
  size: [36, 36],
  anchor: [18, 18]
});

export const incidentIcons = {
  Accident: createEmojiBadgeIcon({
    glyphEntity: "&#x1F4A5;",
    variantClass: "badge-incident-accident",
    size: [36, 36],
    anchor: [18, 18]
  }),
  "Road Work": createEmojiBadgeIcon({
    glyphEntity: "&#x1F6A7;",
    variantClass: "badge-incident-roadwork",
    size: [36, 36],
    anchor: [18, 18]
  }),
  "Traffic Jam": createEmojiBadgeIcon({
    glyphEntity: "&#x1F6A6;",
    variantClass: "badge-incident-traffic",
    size: [36, 36],
    anchor: [18, 18]
  }),
  Flood: createEmojiBadgeIcon({
    glyphEntity: "&#x1F30A;",
    variantClass: "badge-incident-flood",
    size: [36, 36],
    anchor: [18, 18]
  })
};
