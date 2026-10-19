import { Eager, PostConstruct, Singleton } from 'amoxi';
import type { NewUser, User } from '../domain/user';
import type { Clock } from '../infra/clock';
import type { IdGenerator } from '../infra/id-generator';

export interface UserRepository {
  findAll(limit?: number): User[];
  findById(id: number): User | undefined;
  save(user: NewUser): User;
  delete(id: number): boolean;
  count(): number;
}

@Singleton()
@Eager() // created during startup (Micronaut's @Context) so seed data is ready
export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<number, User>();

  // Injected by interface: the compiler resolves `IdGenerator` and `Clock` to the factory beans.
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  @PostConstruct()
  seed(): void {
    this.save({ name: 'Ada Larkwhistle', email: 'ada@example.com' });
    this.save({ name: 'Grace Hollowmere', email: 'grace@example.com' });
  }

  findAll(limit = Infinity): User[] {
    return [...this.users.values()].slice(0, limit);
  }

  findById(id: number): User | undefined {
    return this.users.get(id);
  }

  save(input: NewUser): User {
    const user: User = { id: this.ids.next(), ...input, createdAt: this.clock.now().toISOString() };
    this.users.set(user.id, user);
    return user;
  }

  delete(id: number): boolean {
    return this.users.delete(id);
  }

  count(): number {
    return this.users.size;
  }
}
