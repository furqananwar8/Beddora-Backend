import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { EmailTemplate } from "../../../type/email";

@Injectable()
export class EmailService {
    constructor(private readonly eventEmitter: EventEmitter2 ){}

    sendInviteUserEmail(payload: EmailTemplate){
        this.eventEmitter.emit("user.invited", payload)
    }

}