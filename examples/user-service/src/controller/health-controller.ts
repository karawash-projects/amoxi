import { Controller, Get, Header } from 'amoxi';
import type { Clock } from '../infra/clock';
import type { UserRepository } from '../repository/user-repository';

@Controller('/health')
export class HealthController {
  constructor(
    private readonly repository: UserRepository,
    private readonly clock: Clock,
  ) {}

  @Get()
  health(@Header('user-agent') agent?: string) {
    return { status: 'UP', users: this.repository.count(), time: this.clock.now().toISOString(), agent };
  }
}
