const TRAFFIC_POLICIES = new Set(['Cluster', 'PreferSameZone', 'SameZone']);

function matchesSelector(labels = {}, selector = {}) {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function endpointKey(endpoint) {
  if (endpoint.targetRef && endpoint.targetRef.name) {
    return `pod:${endpoint.targetRef.name}`;
  }
  const addresses = [...(endpoint.addresses || [])].sort().join(',');
  return `addr:${addresses}`;
}

function hintZones(endpoint) {
  const forZones = endpoint.hints && Array.isArray(endpoint.hints.forZones)
    ? endpoint.hints.forZones
    : [];
  return forZones.map((entry) => entry.name).filter(Boolean);
}

function normalizeConditions(conditions = {}) {
  return {
    ready: conditions.ready !== false,
    serving: conditions.serving !== false,
    terminating: conditions.terminating === true,
  };
}

function normalizePodState(pod) {
  return {
    ready: pod.ready !== false,
    serving: pod.serving !== false,
    terminating: pod.terminating === true,
  };
}

export function validateEndpointSlices(input) {
  const { service = {}, pods = [], endpointSlices = [] } = input;
  const selector = service.selector || {};
  const trafficPolicy = service.trafficPolicy || 'Cluster';
  if (!TRAFFIC_POLICIES.has(trafficPolicy)) {
    throw new Error(`unsupported trafficPolicy: ${trafficPolicy}`);
  }

  const podsByName = new Map(pods.map((pod) => [pod.name, pod]));
  const unsafeRoutes = [];
  const conflictingSlices = [];
  const duplicateSlices = [];

  const portsByName = new Map();
  for (const slice of endpointSlices) {
    for (const port of slice.ports || []) {
      if (!port.name) continue;
      const signature = `${port.port}/${port.protocol || 'TCP'}`;
      if (!portsByName.has(port.name)) {
        portsByName.set(port.name, new Map());
      }
      const signatures = portsByName.get(port.name);
      if (!signatures.has(signature)) {
        signatures.set(signature, []);
      }
      signatures.get(signature).push(slice.name);
    }
  }
  for (const [portName, signatures] of portsByName) {
    if (signatures.size > 1) {
      conflictingSlices.push({
        type: 'port-name-conflict',
        portName,
        definitions: [...signatures.entries()].map(([signature, slices]) => ({
          signature,
          slices,
        })),
        message: `port name "${portName}" is defined with conflicting port/protocol across slices`,
      });
    }
  }

  const seenEndpoints = new Map();
  const effective = [];
  const excluded = [];
  const knownZones = new Set();

  for (const pod of pods) {
    if (pod.zone) knownZones.add(pod.zone);
  }

  for (const slice of endpointSlices) {
    for (const endpoint of slice.endpoints || []) {
      const key = endpointKey(endpoint);
      const zones = hintZones(endpoint);
      for (const zone of zones) knownZones.add(zone);
      if (endpoint.zone) knownZones.add(endpoint.zone);

      if (seenEndpoints.has(key)) {
        duplicateSlices.push({
          type: 'duplicate-endpoint',
          endpoint: key,
          slices: [seenEndpoints.get(key), slice.name],
          message: `endpoint ${key} appears in multiple slices and is counted once`,
        });
        continue;
      }
      seenEndpoints.set(key, slice.name);

      const pod = endpoint.targetRef ? podsByName.get(endpoint.targetRef.name) : undefined;
      const sliceState = normalizeConditions(endpoint.conditions);
      const podState = pod ? normalizePodState(pod) : null;
      const reasons = [];

      if (pod && !matchesSelector(pod.labels, selector)) {
        reasons.push('pod-selector-mismatch');
      }
      if (!sliceState.ready) reasons.push('not-ready');
      if (!sliceState.serving) reasons.push('not-serving');
      if (sliceState.terminating) reasons.push('terminating');
      if (podState) {
        if (!podState.ready) reasons.push('pod-not-ready');
        if (!podState.serving) reasons.push('pod-not-serving');
        if (podState.terminating) reasons.push('pod-terminating');
        if (podState.terminating && sliceState.serving && !sliceState.terminating) {
          unsafeRoutes.push({
            type: 'state-mismatch',
            endpoint: key,
            slice: slice.name,
            message: `slice reports serving while pod ${pod.name} is terminating`,
          });
        }
      }

      const record = {
        key,
        name: endpoint.targetRef ? endpoint.targetRef.name : key,
        addresses: endpoint.addresses || [],
        zone: endpoint.zone || (pod && pod.zone) || null,
        hints: zones,
        slice: slice.name,
      };

      const serving = reasons.length === 0;
      if (serving) {
        effective.push(record);
      } else {
        excluded.push({ ...record, reasons });
        if (zones.length > 0) {
          unsafeRoutes.push({
            type: sliceState.terminating ? 'hints-to-terminating-endpoint' : 'hints-to-unserving-endpoint',
            endpoint: key,
            slice: slice.name,
            zones,
            message: `hints steer traffic from zones [${zones.join(', ')}] to non-effective endpoint ${key}`,
          });
        }
      }
    }
  }

  const zones = {};
  for (const zone of knownZones) {
    zones[zone] = { endpoints: [], count: 0 };
  }

  for (const endpoint of effective) {
    let targetZones;
    if (endpoint.hints.length > 0) {
      targetZones = endpoint.hints;
    } else if (trafficPolicy === 'Cluster') {
      targetZones = [...knownZones];
    } else {
      targetZones = endpoint.zone ? [endpoint.zone] : [];
    }
    for (const zone of targetZones) {
      if (!zones[zone]) zones[zone] = { endpoints: [], count: 0 };
      zones[zone].endpoints.push(endpoint);
      zones[zone].count += 1;
    }
  }

  if (trafficPolicy !== 'Cluster') {
    for (const [zone, bucket] of Object.entries(zones)) {
      if (bucket.count === 0) {
        unsafeRoutes.push({
          type: 'zone-failure',
          zone,
          message: `zone ${zone} has no effective endpoints under ${trafficPolicy} policy`,
        });
      }
    }
  }

  return {
    service: service.name || null,
    trafficPolicy,
    zones,
    endpoints: { effective, excluded },
    conflictingSlices,
    duplicateSlices,
    unsafeRoutes,
  };
}
