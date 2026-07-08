from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["telegram"])


class MemberJoined(BaseModel):
    username: str
    display_name: str
    user_id: str
    server_name: str
    join_time: str
    account_created: str
    account_age: str
    member_number: int
    inviter: str
    invite_code: str
    bot_or_human: str
    avatar_url: str
    dm_status: str
    assigned_role: str


@router.post("/member-joined")
async def member_joined(data: MemberJoined):
    """
    Temporary endpoint for Discord bot.
    It simply receives the member information.
    """

    print("========== NEW MEMBER ==========")
    print(data.model_dump())
    print("================================")

    return {
        "success": True,
        "message": "Member data received."
    }
