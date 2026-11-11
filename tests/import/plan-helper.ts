// Small plans in the shape of `terraform show -json` output, for the import tests.
import { stripLastKey } from '../../src/import/terraform/plan.ts';

/** A plan in `terraform show -json` shape from a short list of resources. */
/** `unknown`: attributes known only after apply (resource_changes[].change.after_unknown). */
export interface R { address: string; values?: Record<string, unknown>; expressions?: Record<string, unknown>; sensitive?: Record<string, unknown>; unknown?: string[] }
export function plan(resources: R[]) {
  const parse = (a: string) => {
    const m = /^(?:(.*\.))?(aws_[a-z0-9_]+)\.([A-Za-z0-9_-]+)(?:\[(.+)\])?$/.exec(a)!;
    return { type: m[2], name: m[3], index: m[4] === undefined ? undefined : /^\d+$/.test(m[4]) ? Number(m[4]) : JSON.parse(m[4]) };
  };
  const seen = new Set<string>();
  return {
    format_version: '1.2',
    terraform_version: '1.17.1',
    planned_values: {
      root_module: {
        resources: resources.map((r) => {
          const p = parse(r.address);
          return { address: r.address, mode: 'managed', type: p.type, name: p.name, ...(p.index !== undefined ? { index: p.index } : {}), values: r.values ?? {}, sensitive_values: r.sensitive ?? {} };
        }),
      },
    },
    resource_changes: resources.filter((r) => r.unknown?.length).map((r) => ({ address: r.address, change: { after_unknown: afterUnknown(r.unknown!) } })),
    configuration: {
      root_module: {
        resources: resources
          .map((r) => ({ ...parse(r.address), address: stripLastKey(r.address), expressions: r.expressions ?? {} }))
          .filter((r) => !seen.has(r.address) && seen.add(r.address))
          .map((r) => ({ address: r.address, mode: 'managed', type: r.type, name: r.name, expressions: r.expressions })),
      },
    },
  };
}
/** `a.b` puts `b` inside the block `a` (a list of one object), as Terraform writes it. */
function afterUnknown(paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const [k, ...rest] = p.split('.');
    if (!rest.length) out[k] = true;
    else ((out[k] ??= [{}]) as Record<string, unknown>[])[0] = { ...(out[k] as Record<string, unknown>[])[0], ...afterUnknown([rest.join('.')]) };
  }
  return out;
}
export const refs = (...addresses: string[]) => ({ references: addresses.flatMap((a) => [`${a}.arn`, a]) });

export const CPU = [{ predefined_metric_type: 'ECSServiceAverageCPUUtilization' }];
/** ALB -> listener -> target group <- ECS service, with autoscaling; `over` replaces or adds resources, `drop` removes them. */
export function ecsPlan(over: R[] = [], drop: string[] = []): unknown {
  const base: R[] = [
    { address: 'aws_lb.web', values: { internal: false } },
    { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web'), default_action: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
    { address: 'aws_lb_target_group.a', values: { protocol: 'HTTP' } },
    { address: 'aws_ecs_service.s', values: { desired_count: 2 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
    { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', min_capacity: 2, max_capacity: 8 }, expressions: { resource_id: refs('aws_ecs_service.s') } },
    { address: 'aws_appautoscaling_policy.p', values: { target_tracking_scaling_policy_configuration: [{ target_value: 70, predefined_metric_specification: CPU }] }, expressions: { resource_id: refs('aws_appautoscaling_target.t') } },
  ];
  const byAddress = new Map(base.map((x) => [x.address, x]));
  for (const a of drop) byAddress.delete(a);
  for (const x of over) byAddress.set(x.address, x);
  return plan([...byAddress.values()]);
}
