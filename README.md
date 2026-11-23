# kubernetes-endpointslice-topology-validator
验证 EndpointSlice、区域拓扑和故障域一致性

## 概述

本工具**离线**校验 EndpointSlice，不连接 Kubernetes API Server、不依赖 kubeconfig，
也不发起任何网络请求。输入是一份静态 JSON（可来自 `kubectl get ... -o json` 的导出，
或手工构造的故障演练数据），输出各区域的有效端点集、冲突切片和不安全路由。

## 输入

```json
{
  "service": {
    "name": "web",
    "selector": { "app": "web" },
    "trafficPolicy": "PreferSameZone"
  },
  "pods": [
    { "name": "web-a", "labels": { "app": "web" }, "zone": "zone-a",
      "ready": true, "serving": true, "terminating": false }
  ],
  "endpointSlices": [
    {
      "name": "web-abc",
      "ports": [{ "name": "http", "port": 80, "protocol": "TCP" }],
      "endpoints": [
        {
          "targetRef": { "name": "web-a" },
          "addresses": ["10.0.0.1"],
          "zone": "zone-a",
          "conditions": { "ready": true, "serving": true, "terminating": false },
          "hints": { "forZones": [{ "name": "zone-a" }] }
        }
      ]
    }
  ]
}
```

- `trafficPolicy`：`Cluster`（任意区域）、`PreferSameZone` / `SameZone`（按 hints 或同区域路由）。
- 有效端点需同时满足：Pod 匹配服务选择器，且切片与 Pod 的 `ready`、`serving` 均为真、`terminating` 为假。

## 校验规则

- **区域端点集**：按拓扑 hints（无 hints 时按流量策略）计算每个区域可服务的有效端点。
- **端口冲突**：同名端口在不同切片中定义了不同的 port/protocol，判定为冲突切片。
- **重复切片**：同一端点（按 `targetRef` 或地址）出现在多个切片中只计数一次，并记录重复。
- **不安全路由**：hints 指向 terminating / 非 serving 端点、切片与 Pod 状态不一致
  （切片报 serving 但 Pod 正在 terminating）、以及同区域策略下某区域无任何有效端点（区域故障）。

## 使用

```sh
node bin/validate.js input.json      # 或 cat input.json | node bin/validate.js -
```

输出 JSON 报告，包含 `zones`（各区域端点集）、`endpoints.effective/excluded`、
`conflictingSlices`、`duplicateSlices`、`unsafeRoutes`。
存在不安全路由或端口冲突时退出码为 1，输入非法时为 2，否则为 0。

## 测试

```sh
node --test
```

测试覆盖：区域故障、terminating 端点、重复端点去重、hints 与 serving 状态不一致、
同名端口冲突和非法流量策略。
