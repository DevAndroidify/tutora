import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class PageQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset: number = 0;
}

export class SkillSearchQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Text to match in skill name or description.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Top-level categories include sub-categories.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class TutorSearchQuery extends PageQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only tutors approved for this skill.' })
  @IsOptional()
  @IsUUID()
  skillId?: string;
}
