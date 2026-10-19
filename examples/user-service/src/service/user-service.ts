import { Intercept, Singleton, Value } from 'amoxi';
import { ActivityHub } from '../activity/activity-hub';
import { AvatarStore } from '../avatars/avatar-store';
import { TimingInterceptor } from '../observability/timing-interceptor';
import type { NewUser, User } from '../domain/user';
import { NotificationService } from '../notification/notification-service';
import type { UserRepository } from '../repository/user-repository';

export class UserLimitReachedError extends Error {}

// AOP: every public method is timed; durations show up in the Server-Timing header.
@Singleton()
@Intercept(TimingInterceptor)
export class UserService {
  constructor(
    private readonly repository: UserRepository,
    private readonly notifications: NotificationService,
    private readonly activity: ActivityHub,
    private readonly avatars: AvatarStore,
    @Value('${users.max-count:1000}') private readonly maxUsers: number,
  ) {}

  list(limit?: number): User[] {
    return this.repository.findAll(limit);
  }

  get(id: number): User | undefined {
    return this.repository.findById(id);
  }

  remove(id: number): boolean {
    const user = this.repository.findById(id);
    const removed = this.repository.delete(id);
    if (removed) {
      this.avatars.remove(id);
      this.notifications.auditLog(`user ${id} removed`);
      this.activity.publish('removed', user!.name);
    }
    return removed;
  }

  register(input: NewUser): User {
    if (this.repository.count() >= this.maxUsers) {
      throw new UserLimitReachedError(`User limit of ${this.maxUsers} reached`);
    }
    const user = this.repository.save(input);
    this.notifications.broadcast(`Welcome aboard, ${user.name}!`);
    this.notifications.auditLog(`user ${user.id} registered`);
    this.activity.publish('added', user.name);
    return user;
  }
}
