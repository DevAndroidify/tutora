import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { SUGGESTION_STATUSES } from '../../modules/catalog/catalog.schema';
import {
  APPROVABLE_BADGES,
  TUTOR_SKILL_STATUSES,
  VERIFICATION_STATUSES,
} from '../../modules/tutors/tutors.schema';
import { PageQuery, trim } from '../common/dto';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------- Tutor verification ----------

export class ApproveTutorDto {
  @ApiProperty({ enum: APPROVABLE_BADGES })
  @IsIn(APPROVABLE_BADGES)
  badge!: (typeof APPROVABLE_BADGES)[number];
}

export class RejectDto {
  @ApiProperty({ minLength: 5, maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @Length(5, 1000)
  reason!: string;
}

export class ProfileReviewQuery {
  @ApiPropertyOptional({ enum: VERIFICATION_STATUSES, default: 'PENDING' })
  @IsOptional()
  @IsIn(VERIFICATION_STATUSES)
  status?: (typeof VERIFICATION_STATUSES)[number];
}

export class SkillReviewQuery {
  @ApiPropertyOptional({ enum: TUTOR_SKILL_STATUSES, default: 'PENDING' })
  @IsOptional()
  @IsIn(TUTOR_SKILL_STATUSES)
  status?: (typeof TUTOR_SKILL_STATUSES)[number];
}

// ---------- Catalog ----------

export class CreateCategoryDto {
  @ApiProperty({ example: 'Fitness & Wellness' })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiPropertyOptional({ example: 'fitness-wellness' })
  @IsOptional()
  @Matches(SLUG, { message: 'slug must be lowercase words joined by hyphens' })
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Makes this a sub-category.' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateSkillDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'Options Trading Basics' })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(SLUG, { message: 'slug must be lowercase words joined by hyphens' })
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Shown to learners before booking.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  learnerNotice?: string;
}

export class UpdateSkillDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ nullable: true, description: 'null removes the notice.' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  learnerNotice?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateTopicDto {
  @ApiProperty({ example: 'Option Greeks' })
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(SLUG, { message: 'slug must be lowercase words joined by hyphens' })
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class AdminSkillQuery extends PageQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

export class SuggestionQuery {
  @ApiPropertyOptional({ enum: SUGGESTION_STATUSES, default: 'PENDING' })
  @IsOptional()
  @IsIn(SUGGESTION_STATUSES)
  status?: (typeof SUGGESTION_STATUSES)[number];
}

export class ApproveSuggestionDto {
  @ApiPropertyOptional({ description: 'Override the suggested name.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(SLUG, { message: 'slug must be lowercase words joined by hyphens' })
  @MaxLength(80)
  slug?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Move to another category.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  learnerNotice?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}
