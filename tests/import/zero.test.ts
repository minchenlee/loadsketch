// M29b #22 #43: a service known to have 0 instances is not "not set" (the loadsketch default 2). loadsketch
// needs at least 1, so it gets 1, with a note.
import { describe, expect, it } from 'vitest';
import { importTerraform, type ImportResult } from '../../src/import/terraform/index.ts';
import { ecsPlan, plan, refs } from './plan-helper.ts';

const zeroNote = (r: ImportResult) => r.notes.filter((n) => n.id === 'import.approx.instancesZero').map((n) => n.args!.from);

describe('0 instances', () => {
  it('#43 ECS desired_count 0 and no scaling: 1 instance, a note', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_ecs_service.s', values: { desired_count: 0 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } }], ['aws_appautoscaling_target.t', 'aws_appautoscaling_policy.p']));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params).toMatchObject({ instances: 1 });
    expect(r.origins.ecs_service_s.instances.evidence).toBe('iac');
    expect(zeroNote(r)).toEqual(['aws_ecs_service.s.desired_count']);
  });
  it('ECS desired_count unknown until apply: still left out, no 0 note', () => {
    const r = importTerraform(ecsPlan([{ address: 'aws_ecs_service.s', values: {}, expressions: { desired_count: { references: ['var.n'] }, load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] }, unknown: ['desired_count'] }], ['aws_appautoscaling_target.t', 'aws_appautoscaling_policy.p']));
    expect(r.design.nodes.find((n) => n.id === 'ecs_service_s')!.params?.instances).toBeUndefined();
    expect(zeroNote(r)).toEqual([]);
  });
  it('ECS desired_count 0 with a sensitive min_capacity: not known to be 0', () => {
    const r = importTerraform(ecsPlan([
      { address: 'aws_ecs_service.s', values: { desired_count: 0 }, expressions: { load_balancer: [{ target_group_arn: refs('aws_lb_target_group.a') }] } },
      { address: 'aws_appautoscaling_target.t', values: { service_namespace: 'ecs', max_capacity: 8 }, expressions: { resource_id: refs('aws_ecs_service.s'), min_capacity: { references: ['var.min'] } }, sensitive: { min_capacity: true } },
    ]));
    expect(zeroNote(r)).toEqual([]);
  });
  it('ASG min 0 with a sensitive desired_capacity: not known to be 0', () => {
    const r = importTerraform(plan([
      { address: 'aws_lb.web', values: { internal: false } },
      { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web'), default_action: [{ target_group_arn: refs('aws_lb_target_group.t') }] } },
      { address: 'aws_lb_target_group.t', values: {} },
      { address: 'aws_autoscaling_group.a', values: { min_size: 0, max_size: 8 }, expressions: { target_group_arns: refs('aws_lb_target_group.t'), desired_capacity: { references: ['var.n'] } }, sensitive: { desired_capacity: true } },
    ]));
    expect(r.design.nodes.find((n) => n.id === 'autoscaling_group_a')!.params?.instances).toBeUndefined();
    expect(zeroNote(r)).toEqual([]);
  });
  it('#22 ASG desired, min and max all 0: 1 instance, a note', () => {
    const r = importTerraform(plan([
      { address: 'aws_lb.web', values: { internal: false } },
      { address: 'aws_lb_listener.l', expressions: { load_balancer_arn: refs('aws_lb.web'), default_action: [{ target_group_arn: refs('aws_lb_target_group.t') }] } },
      { address: 'aws_lb_target_group.t', values: {} },
      { address: 'aws_autoscaling_group.a', values: { min_size: 0, max_size: 0, desired_capacity: 0 }, expressions: { target_group_arns: refs('aws_lb_target_group.t') } },
    ]));
    expect(r.design.nodes.find((n) => n.id === 'autoscaling_group_a')!.params).toMatchObject({ instances: 1 });
    expect(zeroNote(r)).toEqual(['aws_autoscaling_group.a.min_size']);
  });
});
