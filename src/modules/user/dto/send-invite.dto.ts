import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendInviteDto {
  @ApiProperty({ example: 'user@example.com', description: 'Email address to invite' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @ApiPropertyOptional({ example: 'John Doe', description: 'Name of the invited user' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'Acme Corp', description: 'Company name to display in the email' })
  @IsString()
  @IsOptional()
  companyName?: string;
}